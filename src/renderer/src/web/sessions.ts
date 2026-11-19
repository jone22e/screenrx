import { parseTranscript } from '@shared/models/captions'
import type { EditorClip, EditorImage, EditorSession, MusicTrack } from '@shared/models/editor'
import { appError } from '@shared/models/errors'
import type { AppError } from '@shared/models/errors'
import type { Project } from '@shared/models/project'
import { createProject, parseProject } from '@shared/models/project'
import { describeMp4 } from '@engine/mp4/mp4Demux'
import type { ByteSource } from '@engine/mp4/mp4Demux'
import { mediaMetadata } from './files'
import type { RecentVideo, StoredAsset } from './storage'
import { webStorage } from './storage'

/** A file brought into a session, as held while the page is open: the stored record plus an address to show it at. */
export interface LoadedAsset extends StoredAsset {
  url: string
}

/** A video the user opened, as the page holds it. */
export interface OpenedVideo {
  sessionId: string
  file: File
  /** A blob address the players read the file at. */
  url: string
  title: string
  createdAt: string
  durationMs: number
  widthPx: number
  heightPx: number
  hasAudio: boolean
  assets: Map<string, LoadedAsset>
  /** The project as last saved in this visit, for the exporter. */
  project: Project | null
}

export class OpenVideoError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'OpenVideoError'
  }
}

/** Random access to a `File` or `Blob`, for the demuxer. */
export const blobSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
})

/**
 * The same file opened twice is the same session, so its project comes
 * back: the id is a digest of what identifies the file without reading it.
 */
async function sessionIdOf(file: File): Promise<string> {
  const bytes = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `web-${[...digest.subarray(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const titleOf = (file: File): string => file.name.replace(/\.[^.]+$/, '') || file.name

/**
 * The videos opened in this visit, by session id. Opening a file probes it
 * (the browser must play it; the demuxer must read it, since the export
 * decodes it frame by frame) and brings back what was saved for it before.
 */
class WebSessions {
  private readonly opened = new Map<string, OpenedVideo>()

  get(sessionId: string): OpenedVideo | null {
    return this.opened.get(sessionId) ?? null
  }

  /** Opens a video file; throws `OpenVideoError` when it cannot be edited here. */
  async open(file: File, handle: FileSystemFileHandle | null = null): Promise<OpenedVideo> {
    const sessionId = await sessionIdOf(file)
    const existing = this.opened.get(sessionId)
    if (existing) return existing

    let description
    try {
      description = await describeMp4(blobSource(file))
    } catch (error) {
      throw new OpenVideoError(appError('import-unsupported', String(error)))
    }
    if (!description.video) {
      throw new OpenVideoError(appError('import-unsupported', `video codec ${description.unsupportedVideo ?? 'none'}`))
    }
    const url = URL.createObjectURL(file)
    const metadata = await mediaMetadata(url, 'video')
    if (!metadata || metadata.widthPx === 0) {
      URL.revokeObjectURL(url)
      throw new OpenVideoError(appError('import-unsupported', 'the browser cannot play this video'))
    }

    const assets = new Map<string, LoadedAsset>()
    for (const asset of await webStorage.listAssets(sessionId).catch(() => [] as StoredAsset[])) {
      assets.set(asset.file, { ...asset, url: URL.createObjectURL(asset.blob) })
    }
    const video: OpenedVideo = {
      sessionId,
      file,
      url,
      title: titleOf(file),
      createdAt: new Date(file.lastModified).toISOString(),
      durationMs: metadata.durationMs || Math.round(description.durationMs),
      widthPx: metadata.widthPx,
      heightPx: metadata.heightPx,
      hasAudio: description.audio !== null,
      assets,
      project: null
    }
    this.opened.set(sessionId, video)

    const recent: RecentVideo = {
      sessionId,
      title: video.title,
      sizeBytes: file.size,
      durationMs: video.durationMs,
      openedAt: new Date().toISOString(),
      ...(handle ? { handle } : {})
    }
    webStorage.writeRecent(recent).catch(() => undefined)
    return video
  }

  /** Everything the editor needs for the video, with its project as saved before or a fresh one. */
  async editorSession(sessionId: string): Promise<EditorSession> {
    const video = this.require(sessionId)
    const saved = await webStorage.readProject(sessionId).catch(() => undefined)
    const project = (saved ? parseProject(saved, sessionId) : null) ?? createProject(sessionId)
    video.project = project
    const transcript = parseTranscript(await webStorage.readTranscript(sessionId).catch(() => undefined))
    return {
      sessionId,
      title: video.title,
      createdAt: video.createdAt,
      durationMs: video.durationMs,
      // A file from elsewhere has whatever pointer it shows burned in; none is drawn.
      cursorInVideo: true,
      video: { url: video.url, widthPx: video.widthPx, heightPx: video.heightPx },
      webcam: null,
      // The file's own sound is the voice track: the one the mix and the captions work from.
      audio: video.hasAudio ? [{ kind: 'microphone', url: video.url }] : [],
      interactions: [],
      cursor: [],
      track: null,
      dubs: [],
      music: this.musicOf(video),
      images: this.imagesOf(video),
      clips: this.clipsOf(video),
      filterTrack: null,
      transcript,
      project
    }
  }

  async saveProject(project: Project): Promise<void> {
    const video = this.require(project.sessionId)
    video.project = project
    await webStorage.writeProject(project)
  }

  imagesOf(video: OpenedVideo): EditorImage[] {
    return [...video.assets.values()]
      .filter((asset) => asset.kind === 'image')
      .map((asset) => ({ file: asset.file, name: asset.name, url: asset.url, widthPx: asset.widthPx, heightPx: asset.heightPx }))
  }

  clipsOf(video: OpenedVideo): EditorClip[] {
    return [...video.assets.values()]
      .filter((asset) => asset.kind === 'clip')
      .map((asset) => ({ file: asset.file, name: asset.name, url: asset.url, durationMs: asset.durationMs, widthPx: asset.widthPx, heightPx: asset.heightPx, hasAudio: false }))
  }

  musicOf(video: OpenedVideo): MusicTrack | null {
    const music = [...video.assets.values()].find((asset) => asset.kind === 'music')
    return music ? { url: music.url, durationMs: music.durationMs, name: music.name } : null
  }

  /** Keeps a file brought into the session, in the browser and for this visit. */
  async addAsset(sessionId: string, asset: Omit<StoredAsset, 'key' | 'sessionId'>): Promise<LoadedAsset> {
    const video = this.require(sessionId)
    const stored: StoredAsset = { ...asset, key: `${sessionId}/${asset.file}`, sessionId }
    await webStorage.writeAsset(stored)
    const loaded: LoadedAsset = { ...stored, url: URL.createObjectURL(asset.blob) }
    video.assets.set(asset.file, loaded)
    return loaded
  }

  async removeAsset(sessionId: string, file: string): Promise<void> {
    const video = this.require(sessionId)
    const asset = video.assets.get(file)
    if (!asset) return
    video.assets.delete(file)
    URL.revokeObjectURL(asset.url)
    await webStorage.removeAsset(sessionId, file)
  }

  require(sessionId: string): OpenedVideo {
    const video = this.opened.get(sessionId)
    if (!video) throw new Error(`No video open as ${sessionId}`)
    return video
  }
}

export const webSessions = new WebSessions()
