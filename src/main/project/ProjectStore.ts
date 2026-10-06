import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { generateAutoZooms } from '@engine/zoom/autoZoom'
import { SESSION_FILES } from '@shared/config/recording'
import { parseTranscript } from '@shared/models/captions'
import type { EditorSession } from '@shared/models/editor'
import type { DubTrack } from '@shared/models/dub'
import { DUB_TRACKS, trackUrl } from '@shared/models/media'
import type { Project } from '@shared/models/project'
import { CAPTION_LANGUAGES, createProject, parseProject } from '@shared/models/project'
import type { InteractionEvent } from '@shared/models/telemetry'
import { parseInteractions } from '@shared/models/telemetry'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class SessionNotEditableError extends Error {
  constructor(reason: string) {
    super(`Session cannot be edited: ${reason}`)
    this.name = 'SessionNotEditableError'
  }
}

/**
 * Projects on disk: `project.json` next to the tracks it edits. The tracks
 * themselves are never touched; saving a project only rewrites this file,
 * atomically, so an unexpected exit cannot corrupt the edit.
 */
export class ProjectStore {
  private readonly opening = new Map<string, Promise<EditorSession>>()

  constructor(
    private readonly sessions: SessionStore,
    private readonly logger: Logger
  ) {}

  /**
   * Loads a recording for editing. A recording opened for the first time
   * gets its project created here, with zooms generated from its telemetry.
   */
  open(sessionId: string): Promise<EditorSession> {
    // Concurrent opens of the same recording share one load, so a new
    // project is generated (and written) exactly once.
    let pending = this.opening.get(sessionId)
    if (!pending) {
      pending = this.load(sessionId).finally(() => this.opening.delete(sessionId))
      this.opening.set(sessionId, pending)
    }
    return pending
  }

  private async load(sessionId: string): Promise<EditorSession> {
    const manifest = await this.sessions.read(sessionId)
    const screen = manifest?.assets.screen
    if (!manifest || manifest.status !== 'completed' || !screen) {
      throw new SessionNotEditableError(manifest ? manifest.status : 'no manifest')
    }

    const durationMs = screen.durationMs
    const webcam = manifest.assets.webcam
    const interactions = await this.readInteractions(sessionId)
    let project = await this.read(sessionId)
    if (!project) {
      const zooms = generateAutoZooms(interactions, durationMs, () => `zoom-${randomUUID()}`)
      project = createProject(sessionId, zooms)
      await this.save(project)
      this.logger.info('generated automatic zooms', {
        sessionId,
        interactions: interactions.length,
        zooms: zooms.length
      })
    }

    return {
      sessionId,
      title: manifest.title ?? manifest.source.label,
      createdAt: manifest.createdAt,
      durationMs,
      video: {
        url: trackUrl(sessionId, 'screen'),
        widthPx: screen.widthPx,
        heightPx: screen.heightPx
      },
      webcam: webcam
        ? { url: trackUrl(sessionId, 'webcam'), widthPx: webcam.widthPx, heightPx: webcam.heightPx }
        : null,
      audio: (['microphone', 'systemAudio'] as const)
        .filter((kind) => manifest.assets[kind])
        .map((kind) => ({ kind, url: trackUrl(sessionId, kind) })),
      interactions,
      dubs: await this.dubsOf(sessionId),
      // A transcript that does not parse is simply absent: it can be generated again.
      transcript: parseTranscript(await this.readJson(sessionId, SESSION_FILES.transcript)),
      project
    }
  }

  async save(project: Project): Promise<void> {
    await writeJsonAtomic(this.pathOf(project.sessionId, SESSION_FILES.project), project)
  }

  private async read(sessionId: string): Promise<Project | null> {
    const raw = await this.readJson(sessionId, SESSION_FILES.project)
    if (raw === null) return null
    const project = parseProject(raw, sessionId)
    if (!project) this.logger.warn('ignoring invalid project file', { sessionId })
    return project
  }

  /** The dubbing tracks that exist on disk for a session. */
  private async dubsOf(sessionId: string): Promise<DubTrack[]> {
    const dubs: DubTrack[] = []
    for (const language of CAPTION_LANGUAGES) {
      const track = DUB_TRACKS[language]
      try {
        await access(this.sessions.trackPathOf(sessionId, track))
        dubs.push({ language, url: trackUrl(sessionId, track) })
      } catch {
        // No dubbing in this language.
      }
    }
    return dubs
  }

  private async readInteractions(sessionId: string): Promise<InteractionEvent[]> {
    return parseInteractions(await this.readJson(sessionId, SESSION_FILES.interactions))
  }

  private async readJson(sessionId: string, file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.pathOf(sessionId, file), 'utf8'))
    } catch {
      return null
    }
  }

  private pathOf(sessionId: string, file: string): string {
    return path.join(this.sessions.directoryOf(sessionId), file)
  }
}
