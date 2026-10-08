import { mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import { suggestTitle, transcriptPreview } from '@engine/captions/transcriptPreview'
import type { TranscriptWord } from '@shared/models/captions'
import type { AppError } from '@shared/models/errors'
import type { MediaTrack } from '@shared/models/media'
import { thumbnailUrl } from '@shared/models/media'
import type {
  RecordingSessionManifest,
  RecordingSummary,
  SessionSource,
  RecordingProgress
} from '@shared/models/session'
import {
  SESSION_SCHEMA_VERSION,
  createSessionId,
  isSessionId,
  normalizeSessionTitle
} from '@shared/models/session'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import { resolveInside } from '../filesystem/safePaths'
import type { Logger } from '../logging/logger'

export class InvalidSessionIdError extends Error {
  constructor() {
    super('Invalid session id')
    this.name = 'InvalidSessionIdError'
  }
}

export interface NewSession {
  source: SessionSource
  fps: number
  cursorInVideo: boolean
  /** A name given up front (e.g. a meeting's); without it the source's label is the title. */
  title?: string
}

export interface CreatedSession {
  manifest: RecordingSessionManifest
  directory: string
  /** Where the capture engine writes the screen track. */
  screenPath: string
  /** Where the capture engine writes the pointer telemetry. */
  cursorPath: string
  interactionsPath: string
  /** Where the capture engine writes the companion tracks, when they are enabled. */
  microphonePath: string
  systemAudioPath: string
  webcamPath: string
}

const MAX_ID_ATTEMPTS = 5

/**
 * Recording sessions on disk: one directory per session under the
 * recordings root, holding the immutable tracks plus `session.json`.
 * Session ids are generated here and validated on every lookup, so nothing
 * a renderer sends can address a path outside the root.
 */
export class SessionStore {
  /** Transcripts already read for searching, by session, with the file time they were read at. */
  private readonly transcripts = new Map<string, { mtimeMs: number; text: string }>()
  constructor(
    private readonly root: string,
    private readonly logger: Logger
  ) {}

  /** Throws `InvalidSessionIdError` for anything that is not a well-formed id. */
  directoryOf(sessionId: string): string {
    if (!isSessionId(sessionId)) throw new InvalidSessionIdError()
    return resolveInside(this.root, sessionId)
  }

  screenPathOf(sessionId: string): string {
    return this.trackPathOf(sessionId, 'screen')
  }

  trackPathOf(sessionId: string, track: MediaTrack): string {
    return path.join(this.directoryOf(sessionId), SESSION_FILES[track])
  }

  async create(session: NewSession, now: Date): Promise<CreatedSession> {
    await mkdir(this.root, { recursive: true })
    const { id, directory } = await this.createDirectory(now)
    const manifest: RecordingSessionManifest = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      createdAt: now.toISOString(),
      status: 'recording',
      source: session.source,
      capture: { fps: session.fps, cursorInVideo: session.cursorInVideo },
      clock: { durationMs: 0, pauses: [] },
      assets: {},
      diagnostics: [],
      ...(session.title && { title: session.title })
    }
    await this.write(manifest)
    return {
      manifest,
      directory,
      screenPath: path.join(directory, SESSION_FILES.screen),
      cursorPath: path.join(directory, SESSION_FILES.cursor),
      interactionsPath: path.join(directory, SESSION_FILES.interactions),
      microphonePath: path.join(directory, SESSION_FILES.microphone),
      systemAudioPath: path.join(directory, SESSION_FILES.systemAudio),
      webcamPath: path.join(directory, SESSION_FILES.webcam)
    }
  }

  async write(manifest: RecordingSessionManifest): Promise<void> {
    const directory = this.directoryOf(manifest.id)
    await writeJsonAtomic(path.join(directory, SESSION_FILES.manifest), manifest)
  }

  async read(sessionId: string): Promise<RecordingSessionManifest | null> {
    const directory = this.directoryOf(sessionId)
    try {
      const raw = await readFile(path.join(directory, SESSION_FILES.manifest), 'utf8')
      return parseManifest(JSON.parse(raw), sessionId)
    } catch (error) {
      this.logger.warn('unreadable session manifest', { sessionId, error: String(error) })
      return null
    }
  }

  /**
   * Gives a recording a name of the user's choosing. An empty name removes
   * the custom one, so the source's label shows again. Returns `false` when
   * the session has no readable manifest.
   */
  async rename(sessionId: string, title: string | null): Promise<boolean> {
    const manifest = await this.read(sessionId)
    if (!manifest) return false
    await this.write(withTitle(manifest, title))
    return true
  }

  /** Notes that the recording was exported now. */
  async recordExport(sessionId: string): Promise<void> {
    const manifest = await this.read(sessionId)
    if (manifest) await this.write({ ...manifest, lastExportAt: new Date().toISOString() })
  }

  /** Keeps the start of what was said with the session, once transcribed. */
  async setTranscriptPreview(sessionId: string, preview: string): Promise<void> {
    const manifest = await this.read(sessionId)
    if (manifest) await this.write({ ...manifest, transcriptPreview: preview })
  }

  /** Newest first. Directories without a valid manifest are skipped. */
  async list(): Promise<RecordingSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const summaries = await Promise.all(
      entries.filter(isSessionId).map(async (id) => {
        const manifest = await this.read(id)
        if (!manifest) return null
        return toSummary(await this.withPreview(manifest), await this.editState(id))
      })
    )
    return summaries
      .filter((summary): summary is RecordingSummary => summary !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * The recordings whose transcript contains `query`. Transcripts are read in
   * full, so this is for a search the user typed, not for every listing.
   */
  async searchTranscripts(query: string): Promise<string[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return []
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const hits = await Promise.all(
      entries.filter(isSessionId).map(async (id) => {
        const text = await this.transcriptText(id)
        return text !== null && text.includes(needle) ? id : null
      })
    )
    return hits.filter((id): id is string => id !== null)
  }

  /** A session transcribed before previews existed gets its preview the first time it is listed. */
  private async withPreview(manifest: RecordingSessionManifest): Promise<RecordingSessionManifest> {
    if (manifest.transcriptPreview !== undefined) return manifest
    const words = await this.transcriptWords(manifest.id)
    if (words === null) return manifest
    const next = { ...manifest, transcriptPreview: transcriptPreview(words) }
    await this.write(next).catch(() => undefined)
    return next
  }

  /** What the project says was done to the recording: captions, cuts, zooms, texts. */
  private async editState(sessionId: string): Promise<{ captioned: boolean; edited: boolean }> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.directoryOf(sessionId), SESSION_FILES.project), 'utf8')) as {
        effects?: unknown[]
        texts?: unknown[]
        captions?: { cues?: unknown[] }
      }
      const cues = raw.captions?.cues?.length ?? 0
      const edited = (raw.effects?.length ?? 0) > 0 || (raw.texts?.length ?? 0) > 0
      return { captioned: cues > 0, edited }
    } catch {
      return { captioned: false, edited: false }
    }
  }

  private async transcriptWords(sessionId: string): Promise<TranscriptWord[] | null> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.directoryOf(sessionId), SESSION_FILES.transcript), 'utf8')) as {
        words?: unknown[]
      }
      return (raw.words ?? []).filter(
        (word): word is TranscriptWord => typeof word === 'object' && word !== null && typeof (word as TranscriptWord).text === 'string'
      )
    } catch {
      return null
    }
  }

  /** The whole transcript as one lower-case string, kept while the file does not change. */
  private async transcriptText(sessionId: string): Promise<string | null> {
    const file = path.join(this.directoryOf(sessionId), SESSION_FILES.transcript)
    let mtimeMs: number
    try {
      mtimeMs = (await stat(file)).mtimeMs
    } catch {
      return null
    }
    const cached = this.transcripts.get(sessionId)
    if (cached && cached.mtimeMs === mtimeMs) return cached.text
    const words = await this.transcriptWords(sessionId)
    if (words === null) return null
    const text = words.map((word) => word.text).join(' ').toLocaleLowerCase()
    this.transcripts.set(sessionId, { mtimeMs, text })
    return text
  }

  /**
   * Removes a session that never produced media. Only the manifest and a
   * zero-byte screen track are deleted, and the directory is removed
   * non-recursively, so a session that does hold recorded data is left alone.
   */
  async discardEmpty(sessionId: string): Promise<void> {
    const directory = this.directoryOf(sessionId)
    try {
      const screenPath = path.join(directory, SESSION_FILES.screen)
      if ((await this.fileSize(screenPath)) === 0) {
        await rm(screenPath, { force: true })
      }
      await rm(path.join(directory, SESSION_FILES.manifest), { force: true })
      await rmdir(directory)
    } catch (error) {
      this.logger.warn('could not discard empty session', { sessionId, error: String(error) })
    }
  }

  /**
   * Sessions still marked `recording` when the app starts were cut short by
   * a crash or power loss; mark them failed so the library tells the truth.
   */
  async recoverInterrupted(failure: AppError): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return
    }
    for (const id of entries.filter(isSessionId)) {
      const manifest = await this.read(id)
      if (manifest?.status !== 'recording') continue
      this.logger.warn('marking interrupted session as failed', { sessionId: id })
      await this.write({ ...manifest, status: 'failed', failure })
    }
  }

  async fileSize(filePath: string): Promise<number> {
    try {
      return (await stat(filePath)).size
    } catch {
      return 0
    }
  }

  private async createDirectory(now: Date): Promise<{ id: string; directory: string }> {
    // Ids have millisecond resolution; step forward on the rare collision.
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = createSessionId(new Date(now.getTime() + attempt))
      const directory = this.directoryOf(id)
      try {
        await mkdir(directory)
        return { id, directory }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('Could not allocate a unique session directory')
  }
}

function parseManifest(value: unknown, expectedId: string): RecordingSessionManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const manifest = value as Partial<RecordingSessionManifest>
  const valid =
    manifest.schemaVersion === SESSION_SCHEMA_VERSION &&
    manifest.id === expectedId &&
    typeof manifest.createdAt === 'string' &&
    (manifest.status === 'recording' || manifest.status === 'completed' || manifest.status === 'failed') &&
    typeof manifest.source?.label === 'string' &&
    typeof manifest.clock?.durationMs === 'number' &&
    typeof manifest.assets === 'object' &&
    manifest.assets !== null &&
    Array.isArray(manifest.diagnostics)
  if (!valid) return null
  // A name that is not a usable string is dropped rather than failing the whole manifest.
  return withTitle(manifest as RecordingSessionManifest, normalizeSessionTitle(manifest.title))
}

/** A copy of the manifest with the given name, or without one when `title` is `null`. */
function withTitle(manifest: RecordingSessionManifest, title: string | null): RecordingSessionManifest {
  const next = { ...manifest }
  if (title === null) delete next.title
  else next.title = title
  return next
}

function toSummary(
  manifest: RecordingSessionManifest,
  edit: { captioned: boolean; edited: boolean }
): RecordingSummary {
  const { screen, microphone, systemAudio, webcam } = manifest.assets
  const preview = manifest.transcriptPreview ?? null
  const progress: RecordingProgress = manifest.lastExportAt
    ? 'exported'
    : edit.captioned
      ? 'captioned'
      : edit.edited
        ? 'edited'
        : manifest.source.kind === 'file'
          ? 'imported'
          : 'new'
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    status: manifest.status,
    progress,
    suggestedTitle: manifest.title === undefined && preview ? suggestTitle(preview) : null,
    transcriptPreview: preview,
    title: manifest.title ?? manifest.source.label,
    sourceLabel: manifest.source.label,
    durationMs: manifest.clock.durationMs,
    sizeBytes: [screen, microphone, systemAudio, webcam].reduce((total, asset) => total + (asset?.sizeBytes ?? 0), 0),
    resolution: screen ? { widthPx: screen.widthPx, heightPx: screen.heightPx } : null,
    hasMicrophone: microphone !== undefined,
    hasSystemAudio: systemAudio !== undefined,
    hasWebcam: webcam !== undefined,
    hasWarnings: manifest.diagnostics.some((diagnostic) => diagnostic.level === 'warning'),
    thumbnailUrl: screen && manifest.status === 'completed' ? thumbnailUrl(manifest.id) : null
  }
}
