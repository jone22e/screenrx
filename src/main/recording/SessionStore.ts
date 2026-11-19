import { cp, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import { suggestTitle, transcriptPreview } from '@engine/captions/transcriptPreview'
import type { Transcript, TranscriptWord } from '@shared/models/captions'
import { parseTranscript } from '@shared/models/captions'
import type { AppError } from '@shared/models/errors'
import type { PublishRecord } from '@shared/models/instagram'
import { parsePublishRecord, publishSummaryOf } from '@shared/models/instagram'
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
  normalizeSeriesName,
  normalizeSessionTitle
} from '@shared/models/session'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import { isSafeFileName, resolveInside } from '../filesystem/safePaths'
import type { Logger } from '../logging/logger'

export class InvalidSessionIdError extends Error {
  constructor() {
    super('Invalid session id')
    this.name = 'InvalidSessionIdError'
  }
}

/** The list of series the user made, next to the recordings. */
const SERIES_FILE = 'series.json'

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

  /** Puts a recording in a series, or takes it out of any when `series` is `null`. The series is kept in the list too. */
  async setSeries(sessionId: string, series: string | null): Promise<boolean> {
    const manifest = await this.read(sessionId)
    if (!manifest) return false
    const next = { ...manifest }
    if (series === null) delete next.series
    else next.series = series
    await this.write(next)
    if (series !== null) await this.addSeries(series)
    return true
  }

  /**
   * The series the user made, in the order made, kept in `series.json` next
   * to the recordings so a series exists before (and after) any recording is
   * in it. Recordings may also name a series that is not here.
   */
  async listSeries(): Promise<string[]> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.root, SERIES_FILE), 'utf8')) as { names?: unknown[] }
      return (raw.names ?? []).filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    } catch {
      return []
    }
  }

  async addSeries(name: string): Promise<void> {
    const names = await this.listSeries()
    if (names.includes(name)) return
    await mkdir(this.root, { recursive: true })
    await writeJsonAtomic(path.join(this.root, SERIES_FILE), { names: [...names, name] })
  }

  /** Removes a series: the recordings in it stay, in no series; the name is forgotten. */
  async removeSeries(name: string): Promise<void> {
    for (const manifest of await this.manifestsInSeries(name)) {
      const next = { ...manifest }
      delete next.series
      await this.write(next)
    }
    const names = await this.listSeries()
    if (names.includes(name)) await writeJsonAtomic(path.join(this.root, SERIES_FILE), { names: names.filter((entry) => entry !== name) })
  }

  /** Gives a series a new name, on every recording in it and in the list. Joins it with a series of that name, if there is one. */
  async renameSeries(from: string, to: string): Promise<void> {
    if (from === to) return
    for (const manifest of await this.manifestsInSeries(from)) await this.write({ ...manifest, series: to })
    const names = await this.listSeries()
    const renamed = names.map((entry) => (entry === from ? to : entry))
    await writeJsonAtomic(path.join(this.root, SERIES_FILE), { names: [...new Set(renamed.includes(to) ? renamed : [...renamed, to])] })
  }

  private async manifestsInSeries(name: string): Promise<RecordingSessionManifest[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const manifests = await Promise.all(entries.filter(isSessionId).map((id) => this.read(id)))
    return manifests.filter((manifest): manifest is RecordingSessionManifest => manifest !== null && manifest.series === name)
  }

  /** The transcript as saved, `null` when there is none. */
  async readTranscript(sessionId: string): Promise<Transcript | null> {
    try {
      return parseTranscript(JSON.parse(await readFile(path.join(this.directoryOf(sessionId), SESSION_FILES.transcript), 'utf8')))
    } catch {
      return null
    }
  }

  /**
   * Gives a recording a cover of its own: the image is copied into the
   * session folder under a name of its own (so the library never shows a
   * cached old one), and the one before is removed. `null` removes the cover.
   */
  async setCover(sessionId: string, image: { bytes: Uint8Array; extension: string } | null): Promise<boolean> {
    const manifest = await this.read(sessionId)
    if (!manifest) return false
    const next = { ...manifest }
    delete next.cover
    if (image) {
      next.cover = `cover-${Date.now()}.${image.extension}`
      await writeFile(path.join(this.directoryOf(sessionId), next.cover), image.bytes)
    }
    await this.write(next)
    if (manifest.cover && manifest.cover !== next.cover) await rm(path.join(this.directoryOf(sessionId), manifest.cover), { force: true })
    return true
  }

  /** The cover's path, `null` when the session has none. */
  async coverPathOf(sessionId: string): Promise<string | null> {
    const manifest = await this.read(sessionId)
    return manifest?.cover ? path.join(this.directoryOf(sessionId), manifest.cover) : null
  }

  /** Notes that the recording was exported now. */
  async recordExport(sessionId: string): Promise<void> {
    const manifest = await this.read(sessionId)
    if (manifest) await this.write({ ...manifest, lastExportAt: new Date().toISOString() })
  }

  /**
   * Changes how far the recording is on its way to Instagram (`null`: no
   * longer approved). `change` gets the record as it is now, so a state
   * written meanwhile is not lost. Returns the record written.
   */
  async updatePublish(sessionId: string, change: (current: PublishRecord | null) => PublishRecord | null): Promise<PublishRecord | null> {
    const manifest = await this.read(sessionId)
    if (!manifest) return null
    const next = change(manifest.publish ?? null)
    const written = { ...manifest }
    if (next === null) delete written.publish
    else written.publish = next
    await this.write(written)
    return next
  }

  /**
   * A publish cut short when the app quit (rendering, sending) starts over:
   * back to the queue. One Meta was processing is left to be checked again.
   */
  async requeueInterruptedPublishes(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const requeued: string[] = []
    for (const id of entries.filter(isSessionId)) {
      const manifest = await this.read(id)
      const state = manifest?.publish?.state
      if (manifest?.publish && (state === 'rendering' || state === 'uploading')) {
        await this.write({ ...manifest, publish: { ...manifest.publish, state: 'approved' } })
        requeued.push(id)
      }
    }
    return requeued
  }

  /**
   * A copy of a finished recording with all its edit, under a new id and
   * "(cópia)" after its name, ready to be edited or published apart: what
   * belongs to the original alone — its Instagram post, its last export, the
   * Reels file made for it — stays behind. On APFS the files are cloned, so
   * the copy takes no room until one of them changes. The new id.
   */
  async duplicate(sessionId: string, now: Date): Promise<string> {
    const manifest = await this.read(sessionId)
    if (!manifest || manifest.status !== 'completed') throw new Error('only a finished recording can be duplicated')
    const source = this.directoryOf(sessionId)
    const { id, directory } = await this.createDirectory(now)
    try {
      for (const entry of await readdir(source)) {
        if (entry === 'publish' || entry === SESSION_FILES.manifest || entry.endsWith('.part')) continue
        await cp(path.join(source, entry), path.join(directory, entry), { recursive: true, mode: constants.COPYFILE_FICLONE })
      }
      // The project names its session: the copy's names the copy.
      const projectPath = path.join(directory, SESSION_FILES.project)
      try {
        const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<string, unknown>
        await writeJsonAtomic(projectPath, { ...project, sessionId: id })
      } catch {
        // No edit yet: the copy opens fresh, as the original would.
      }
      const copy: RecordingSessionManifest = { ...manifest, id, createdAt: now.toISOString(), title: copyTitle(manifest.title ?? manifest.source.label) }
      delete copy.publish
      delete copy.lastExportAt
      await this.write(copy)
      this.logger.info('recording duplicated', { from: sessionId, to: id })
      return id
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
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
  // A name, series or cover that is not usable is dropped rather than failing the whole manifest.
  const parsed = withTitle(manifest as RecordingSessionManifest, normalizeSessionTitle(manifest.title))
  const series = normalizeSeriesName(manifest.series)
  if (series === null) delete parsed.series
  else parsed.series = series
  if (typeof manifest.cover !== 'string' || !isSafeFileName(manifest.cover) || !manifest.cover.startsWith('cover-')) delete parsed.cover
  const publish = parsePublishRecord(manifest.publish)
  if (publish === null) delete parsed.publish
  else parsed.publish = publish
  if (typeof manifest.sourceUrl !== 'string' || !/^https?:\/\//.test(manifest.sourceUrl)) delete parsed.sourceUrl
  return parsed
}

/** A copy of the manifest with the given name, or without one when `title` is `null`. */
function withTitle(manifest: RecordingSessionManifest, title: string | null): RecordingSessionManifest {
  const next = { ...manifest }
  if (title === null) delete next.title
  else next.title = title
  return next
}

/** "Aula 1" → "Aula 1 (cópia)"; a copy of a copy stays one copy, numbered. */
export function copyTitle(title: string): string {
  const numbered = /^(.*) \(cópia(?: (\d+))?\)$/.exec(title)
  const base = numbered ? (numbered[1] as string) : title
  const next = numbered ? (numbered[2] ? Number(numbered[2]) + 1 : 2) : 1
  return normalizeSessionTitle(`${base} (cópia${next > 1 ? ` ${next}` : ''})`) ?? title
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
    series: manifest.series ?? null,
    hasCover: manifest.cover !== undefined,
    publish: publishSummaryOf(manifest.publish),
    sourceLabel: manifest.source.label,
    durationMs: manifest.clock.durationMs,
    sizeBytes: [screen, microphone, systemAudio, webcam].reduce((total, asset) => total + (asset?.sizeBytes ?? 0), 0),
    resolution: screen ? { widthPx: screen.widthPx, heightPx: screen.heightPx } : null,
    hasMicrophone: microphone !== undefined,
    hasSystemAudio: systemAudio !== undefined,
    hasWebcam: webcam !== undefined,
    hasWarnings: manifest.diagnostics.some((diagnostic) => diagnostic.level === 'warning'),
    thumbnailUrl: manifest.cover ? thumbnailUrl(manifest.id, manifest.cover) : screen && manifest.status === 'completed' ? thumbnailUrl(manifest.id) : null
  }
}
