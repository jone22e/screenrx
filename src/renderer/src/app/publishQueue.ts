import { applyPlatformPreset, platformPreset } from '@engine/export/platformPresets'
import type { EditorSession } from '@shared/models/editor'
import type { IpcResult } from '@shared/models/errors'
import type { ExportJob, ExportResult } from '@shared/models/export'
import type { PublishProgress, PublishRecord, PublishState } from '@shared/models/instagram'
import type { Project } from '@shared/models/project'
import type { RecordingSummary } from '@shared/models/session'
import type { ObjectTrack } from '@shared/models/telemetry'
import { ExportAbortedError, ExportFailedError, renderExport } from '../export/renderExport'

/**
 * Publishes the approved recordings, one at a time, oldest first, while the
 * app is open: the Reels file is drawn here (the same drawing as any export,
 * at 9:16), then the main process sends it to Instagram and waits for Meta.
 * Nothing is published that was not approved.
 */

export interface PublishQueueState {
  /** The recording under way, and where it is. */
  current: { sessionId: string; title: string; state: PublishState; fraction: number | null } | null
}

export interface PublishQueueDeps {
  startExport(sessionId: string): Promise<IpcResult<ExportJob>>
  openSession(sessionId: string): Promise<IpcResult<EditorSession>>
  render(job: ExportJob, session: EditorSession, project: Project, track: ObjectTrack | null, onFrames: (done: number) => void, signal: AbortSignal): Promise<void>
  finishExport(exportId: string): Promise<IpcResult<ExportResult>>
  cancelExport(exportId: string): Promise<void>
  publish(sessionId: string): Promise<IpcResult<PublishRecord>>
  mark(sessionId: string, state: 'approved' | 'failed', error: string | null): Promise<IpcResult<null>>
  withdraw(sessionId: string): Promise<IpcResult<null>>
  onProgress(listener: (progress: PublishProgress) => void): () => void
  /** Waits before trying again when the exporter is taken (an export from the editor). */
  wait(ms: number): Promise<void>
}

/** The editor is exporting: the queue tries again after this. */
const BUSY_RETRY_MS = 20_000

/** The project as the Reels file is drawn: Reels size and shape, the rest as edited. */
export function reelsProject(project: Project): Project {
  const reels = platformPreset('reels')
  if (!reels) return project
  return { ...project, export: applyPlatformPreset(project.export, reels), background: { ...project.background, aspect: reels.aspect ?? project.background.aspect } }
}

export class PublishQueue {
  private state: PublishQueueState = { current: null }
  private readonly listeners = new Set<() => void>()
  private running = false
  private abort: AbortController | null = null
  private listening = false
  private latest: { recordings: readonly RecordingSummary[]; connected: boolean } | null = null

  constructor(private readonly deps: PublishQueueDeps) {}

  /** Follows the main process' word on the publish under way; from the first run on. */
  private listen(): void {
    if (this.listening) return
    this.listening = true
    this.deps.onProgress((progress) => {
      const { current } = this.state
      if (current && current.sessionId === progress.sessionId) this.update({ current: { ...current, state: progress.state, fraction: progress.fraction } })
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): PublishQueueState => this.state

  /**
   * Looks at the library for approved recordings and works through them.
   * Called whenever the library changes; does nothing while one is under way
   * or when there is no account to publish to.
   */
  consider(recordings: readonly RecordingSummary[], connected: boolean): void {
    this.latest = { recordings, connected }
    if (this.running || !connected) return
    const next = oldestApproved(recordings)
    if (!next) return
    this.listen()
    this.running = true
    void this.work(next).then((outcome) => {
      this.running = false
      this.update({ current: null })
      // Every other ending changes the recording, and the library calls again with the new list.
      if (outcome === 'retry' && this.latest) this.consider(this.latest.recordings, this.latest.connected)
    })
  }

  /** Stops the file being drawn and takes the recording out of the queue (it is no longer approved). */
  stopRendering(): void {
    this.abort?.abort()
  }

  private async work(recording: RecordingSummary): Promise<'done' | 'retry' | 'skipped'> {
    const { deps } = this
    const sessionId = recording.id
    this.update({ current: { sessionId, title: recording.title, state: 'rendering', fraction: 0 } })

    const started = await deps.startExport(sessionId)
    if (!started.ok) {
      if (started.error.code === 'export-busy') {
        await deps.wait(BUSY_RETRY_MS)
        return 'retry'
      }
      // Not waiting any more (the list was older than the recording), or no account: nothing to mark.
      if (started.error.code === 'invalid-state' || started.error.code === 'instagram-not-connected') return 'skipped'
      await deps.mark(sessionId, 'failed', started.error.message)
      return 'done'
    }
    const job = started.value
    const controller = new AbortController()
    this.abort = controller
    try {
      const opened = await deps.openSession(sessionId)
      if (!opened.ok) throw new ExportFailedError(opened.error)
      const session = opened.value
      await deps.render(
        job,
        session,
        reelsProject(session.project),
        session.track,
        (done) => this.update({ current: { sessionId, title: recording.title, state: 'rendering', fraction: job.plan.frameCount > 0 ? done / job.plan.frameCount : null } }),
        controller.signal
      )
      const finished = await deps.finishExport(job.exportId)
      if (!finished.ok) throw new ExportFailedError(finished.error)
    } catch (error) {
      await deps.cancelExport(job.exportId)
      if (error instanceof ExportAbortedError) await deps.withdraw(sessionId)
      else await deps.mark(sessionId, 'failed', error instanceof ExportFailedError ? error.appError.message : 'Não foi possível desenhar o vídeo.')
      return 'done'
    } finally {
      this.abort = null
    }
    // The main process writes how it goes (and a failure) to the recording; the library shows it.
    await deps.publish(sessionId)
    return 'done'
  }

  private update(change: Partial<PublishQueueState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
}

/** The approved recording to publish next: in a series, the first episode first. */
export function oldestApproved(recordings: readonly RecordingSummary[]): RecordingSummary | null {
  const waiting = recordings.filter((recording) => recording.publish?.state === 'approved' && recording.status === 'completed')
  return [...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
}

export const publishQueue = new PublishQueue({
  startExport: (sessionId) => window.screenrx.instagram.startExport(sessionId),
  openSession: (sessionId) => window.screenrx.editor.open(sessionId),
  render: (job, session, project, track, onFrames, signal) => renderExport(job, session, project, track, onFrames, signal),
  finishExport: (exportId) => window.screenrx.export.finish(exportId),
  cancelExport: (exportId) => window.screenrx.export.cancel(exportId),
  publish: (sessionId) => window.screenrx.instagram.publish(sessionId),
  mark: (sessionId, state, error) => window.screenrx.instagram.mark(sessionId, state, error),
  withdraw: (sessionId) => window.screenrx.instagram.withdraw(sessionId),
  onProgress: (listener) => window.screenrx.instagram.onProgress(listener),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
})
