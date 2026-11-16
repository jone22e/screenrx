import type { AiChoice } from '@shared/models/ai'
import type { AutoEditBrief, AutoEditPlan, AutoEditProgress, AutoEditRequest, AutoEditResult, AutoEditStage, WorkerResult, WorkerRole } from '@shared/models/autoEdit'
import type { CaptionTranslationRequest } from '@shared/models/captions'
import type { EditorSession } from '@shared/models/editor'
import type { IpcResult } from '@shared/models/errors'
import type { CaptionLanguage, Project } from '@shared/models/project'
import { libraryRefresh } from '../common/libraryRefresh'
import { EditorStore } from '../editor/EditorStore'
import { editStateOf } from '../editor/editState'

/**
 * "Editar todos com IA" for a series: the editing team goes through the
 * episodes one after the other, with one brief, each in an editor store of
 * its own that never reaches the screen. An episode's project is written
 * only once its team is done, so cancelling leaves the one under way as it
 * was and the ones already edited as they are. Only text leaves the Mac.
 */

export type EpisodeStatus = 'queued' | 'editing' | 'done' | 'failed' | 'cancelled'

export interface EpisodeEntry {
  id: string
  title: string
  status: EpisodeStatus
  /** How many actions landed, once done. */
  actions: number
  /** Why it failed, when it did. */
  error: string | null
}

export type SeriesAutoEditPhase = 'idle' | 'working' | 'done' | 'cancelled'

export interface SeriesAutoEditState {
  phase: SeriesAutoEditPhase
  /** The series being edited, or the last one. */
  series: string | null
  episodes: EpisodeEntry[]
  /** The episode the team is on now: each agent's stage and the director's summary. */
  current: { id: string; stages: Partial<Record<WorkerRole | 'director', AutoEditStage>>; summary: string | null } | null
  startedAt: number
  finishedAt: number | null
}

export interface EpisodeTarget {
  id: string
  title: string
}

/** The doors to the main process the run goes through; the window's in the app, fakes in the tests. */
export interface SeriesAutoEditDeps {
  openSession(sessionId: string): Promise<IpcResult<EditorSession>>
  autoEdit(sessionId: string, request: AutoEditRequest, choice: AiChoice): Promise<IpcResult<AutoEditResult>>
  saveProject(project: Project): Promise<IpcResult<null>>
  cancel(): Promise<void> | void
  translate(request: CaptionTranslationRequest, choice: AiChoice): Promise<IpcResult<Record<string, string>>>
  onProgress(listener: (progress: AutoEditProgress) => void): () => void
  onPlan(listener: (event: { sessionId: string; plan: AutoEditPlan }) => void): () => void
  onWorker(listener: (event: { sessionId: string; result: WorkerResult }) => void): () => void
  /** An episode's project was written: the library should show it as edited. */
  onEpisodeSaved(sessionId: string): void
}

const IDLE: SeriesAutoEditState = { phase: 'idle', series: null, episodes: [], current: null, startedAt: 0, finishedAt: null }

export class SeriesAutoEditRunner {
  private state: SeriesAutoEditState = IDLE
  private readonly listeners = new Set<() => void>()
  private cancelling = false
  private run: Promise<void> | null = null

  constructor(private readonly deps: SeriesAutoEditDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): SeriesAutoEditState => this.state

  get working(): boolean {
    return this.state.phase === 'working'
  }

  /** Whether the run has this recording still to do, or under way: the editor must not open it meanwhile. */
  holds(sessionId: string): boolean {
    return this.working && this.state.episodes.some((episode) => episode.id === sessionId && (episode.status === 'queued' || episode.status === 'editing'))
  }

  /**
   * Edits the episodes, in the order given, one at a time. Resolves when the
   * last is done or the run was cancelled. Refused while another run is on.
   */
  start(series: string, episodes: readonly EpisodeTarget[], brief: AutoEditBrief, choice: AiChoice): Promise<void> {
    if (this.working) return this.run ?? Promise.resolve()
    if (episodes.length === 0) return Promise.resolve()
    this.cancelling = false
    this.update({
      phase: 'working',
      series,
      episodes: episodes.map((episode) => ({ id: episode.id, title: episode.title, status: 'queued', actions: 0, error: null })),
      current: null,
      startedAt: Date.now(),
      finishedAt: null
    })
    this.run = this.runAll(brief, choice).finally(() => {
      this.run = null
    })
    return this.run
  }

  /** Stops the team: the episode under way is left as it was, the ones done stay. */
  cancel(): void {
    if (!this.working) return
    this.cancelling = true
    void this.deps.cancel()
  }

  /** Clears a finished run from the library. */
  dismiss(): void {
    if (this.working) return
    this.update(IDLE)
  }

  private async runAll(brief: AutoEditBrief, choice: AiChoice): Promise<void> {
    for (const episode of this.state.episodes) {
      if (this.cancelling) {
        this.setEpisode(episode.id, { status: 'cancelled' })
        continue
      }
      await this.runEpisode(episode.id, brief, choice)
    }
    this.update({ phase: this.cancelling ? 'cancelled' : 'done', current: null, finishedAt: Date.now() })
  }

  private async runEpisode(sessionId: string, brief: AutoEditBrief, choice: AiChoice): Promise<void> {
    this.setEpisode(sessionId, { status: 'editing' })
    this.update({ current: { id: sessionId, stages: {}, summary: null } })

    const opened = await this.deps.openSession(sessionId).catch(() => null)
    if (this.cancelling) {
      this.setEpisode(sessionId, { status: 'cancelled' })
      return
    }
    if (!opened?.ok) {
      this.setEpisode(sessionId, { status: 'failed', error: opened && !opened.ok ? opened.error.message : 'Não foi possível abrir o episódio.' })
      return
    }

    // The store never reaches the screen; what it would save is kept here and written only at the end.
    const captured: { project: Project | null } = { project: null }
    const store = new EditorStore(opened.value, async (project) => {
      captured.project = project
      return { ok: true, value: null }
    })
    const translations: Promise<void>[] = []
    const translate = (language: CaptionLanguage): void => {
      translations.push(store.translateCaptions(language, (target, cues, sourceLocale) => this.deps.translate({ language: target, cues, sourceLocale }, choice)))
    }
    const landing: Promise<void>[] = []
    const stops = [
      this.deps.onProgress((progress) => {
        if (progress.sessionId !== sessionId) return
        this.setStage(sessionId, progress.who, progress.stage)
      }),
      this.deps.onPlan((event) => {
        if (event.sessionId !== sessionId) return
        this.update({ current: this.state.current && this.state.current.id === sessionId ? { ...this.state.current, summary: event.plan.summary } : this.state.current })
      }),
      this.deps.onWorker((event) => {
        if (event.sessionId !== sessionId) return
        landing.push(
          store.applyWorkerLive(
            event.result.role,
            event.result.actions.map((entry) => entry.action),
            translate,
            0,
            () => {}
          )
        )
      })
    ]

    try {
      store.beginTeam()
      const answer = await this.deps.autoEdit(sessionId, { brief, edit: editStateOf(store) }, choice).catch(() => null)
      await Promise.all(landing)
      store.endTeam()
      if (!answer?.ok) {
        if (this.cancelling || answer?.error.code === 'ai-cancelled') {
          this.cancelling = true
          this.setEpisode(sessionId, { status: 'cancelled' })
        } else {
          this.setEpisode(sessionId, { status: 'failed', error: answer?.error.message ?? 'A IA não respondeu.' })
        }
        return
      }
      await Promise.all(translations)
      await store.flush()
      const actions = answer.value.workers.reduce((sum, worker) => sum + worker.actions.length, 0)
      if (captured.project !== null) {
        const saved = await this.deps.saveProject(captured.project).catch(() => null)
        if (!saved?.ok) {
          this.setEpisode(sessionId, { status: 'failed', error: saved && !saved.ok ? saved.error.message : 'Não foi possível gravar a edição.' })
          return
        }
        this.deps.onEpisodeSaved(sessionId)
      }
      this.setEpisode(sessionId, { status: 'done', actions })
    } finally {
      for (const stop of stops) stop()
    }
  }

  private setStage(sessionId: string, who: WorkerRole | 'director', stage: AutoEditStage): void {
    const { current } = this.state
    if (!current || current.id !== sessionId) return
    this.update({ current: { ...current, stages: { ...current.stages, [who]: stage } } })
  }

  private setEpisode(sessionId: string, change: Partial<EpisodeEntry>): void {
    this.update({ episodes: this.state.episodes.map((episode) => (episode.id === sessionId ? { ...episode, ...change } : episode)) })
  }

  private update(change: Partial<SeriesAutoEditState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
}

/** The run in the app, through the preload bridge. Nothing here touches the window until a run starts. */
export const seriesAutoEdit = new SeriesAutoEditRunner({
  openSession: (sessionId) => window.screenrx.editor.open(sessionId),
  autoEdit: (sessionId, request, choice) => window.screenrx.ai.autoEdit(sessionId, request, choice),
  saveProject: (project) => window.screenrx.editor.saveProject(project),
  cancel: () => window.screenrx.ai.cancel(),
  translate: (request, choice) => window.screenrx.captions.translate(request, choice),
  onProgress: (listener) => window.screenrx.ai.onAutoEditProgress(listener),
  onPlan: (listener) => window.screenrx.ai.onAutoEditPlan(listener),
  onWorker: (listener) => window.screenrx.ai.onAutoEditWorker(listener),
  onEpisodeSaved: () => libraryRefresh.notify()
})
