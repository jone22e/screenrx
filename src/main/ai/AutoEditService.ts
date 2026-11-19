import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { assembleWorkers } from '@engine/ai/assembly'
import { buildDirectorPrompt, parseDirectorResponse } from '@engine/ai/directorPrompt'
import type { RecordingFacts, SecondVideoFacts } from '@engine/ai/recordingSheet'
import { wordsOnRecordingClock } from '../captions/ClipTranscriber'
import { buildRecordingSheet } from '@engine/ai/recordingSheet'
import { buildWorkerPrompt, parseWorkerResponse } from '@engine/ai/workerPrompts'
import { SESSION_FILES } from '@shared/config/recording'
import type { AiChoice, AiEffort } from '@shared/models/ai'
import type { AutoEditPlan, AutoEditProgress, AutoEditRequest, AutoEditRerunRequest, AutoEditResult, WorkerResult, WorkerRole } from '@shared/models/autoEdit'
import { parseTranscript } from '@shared/models/captions'
import type { TranscriptWord } from '@shared/models/captions'
import { parseCursorSamples, parseInteractions } from '@shared/models/telemetry'
import { appError } from '@shared/models/errors'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { AI_PROVIDER_SPECS } from './aiCatalog'
import type { AiCliService } from './AiCliService'
import { AiError } from './AiCliService'

export interface AutoEditServiceDeps {
  ai: AiCliService
  sessions: SessionStore
  logger: Logger
  onProgress: (progress: AutoEditProgress) => void
  /** The director's plan, as soon as it is there. */
  onPlan: (sessionId: string, plan: AutoEditPlan) => void
  /** Each agent's work the moment it is done, already assembled against the cutter's cuts when that is known. */
  onWorker: (sessionId: string, result: WorkerResult) => void
  /** What is said in a clip of the session (the second video), on the clip's clock; absent: not read. */
  clipWords?: (sessionId: string, file: string, durationMs: number, locale: string) => Promise<TranscriptWord[] | null>
}

/** The effort each role works at: the director thinks hard, the cutter and the captioner carefully, the rest quickly. */
const ROLE_EFFORT: Record<WorkerRole | 'director', AiEffort> = {
  // Measured 2026-11-16 on an 84 s recording: the director at "high" took 57 s of an 84 s run; "medium" is the trade.
  director: 'medium',
  cutter: 'medium',
  captioner: 'medium',
  camera: 'low',
  sound: 'low',
  art: 'low'
}

/**
 * The automatic edit: builds the recording sheet, asks the director for a
 * plan, runs the agents the plan briefs in parallel, and returns their
 * work assembled in order with the conflicts taken out. The editor applies
 * it. Only text goes to the tools; nothing is applied here.
 */
export class AutoEditService {
  constructor(private readonly deps: AutoEditServiceDeps) {}

  async run(sessionId: string, request: AutoEditRequest, base: AiChoice): Promise<AutoEditResult> {
    const facts = await this.factsOf(sessionId, request)
    const sheet = buildRecordingSheet(facts, request.brief)
    const startedAt = Date.now()
    this.deps.onProgress({ sessionId, who: 'director', stage: 'thinking', elapsedMs: 0 })
    let plan: AutoEditPlan
    try {
      const director = buildDirectorPrompt(sheet, request.brief)
      const answer = await this.deps.ai.ask(this.choiceFor(base, 'director'), director)
      plan = parseDirectorResponse(answer, facts.words, facts.durationMs, request.brief)
      this.deps.onProgress({ sessionId, who: 'director', stage: 'done', elapsedMs: Date.now() - startedAt })
    } catch (error) {
      this.deps.onProgress({ sessionId, who: 'director', stage: 'failed', elapsedMs: Date.now() - startedAt })
      throw error
    }
    this.deps.logger.info('director planned', { sessionId, chapters: plan.chapters.length, workers: plan.workers.map((worker) => worker.role), elapsedMs: Date.now() - startedAt })
    this.deps.onPlan(sessionId, plan)

    // Each agent is handed over the moment it is done. The cutter's cuts decide what of the others is kept,
    // so an agent that finishes before the cutter waits for it; the cutter itself goes out at once.
    const hasCutter = plan.workers.some((worker) => worker.role === 'cutter')
    let cutter: WorkerResult | null = null
    const waiting: WorkerResult[] = []
    const handOver = (result: WorkerResult): void => {
      const [assembled] = assembleWorkers(cutter ? [cutter, result] : [result], request.edit.cuts, plan.chapters).filter((entry) => entry.role === result.role)
      this.deps.onWorker(sessionId, assembled ?? result)
    }
    const workers = await Promise.all(
      plan.workers.map(async (worker) => {
        const result = await this.runWorker(sessionId, worker.role, sheet, plan, facts, base, '')
        if (result.role === 'cutter') {
          cutter = result
          this.deps.onWorker(sessionId, result)
          for (const queued of waiting.splice(0)) handOver(queued)
        } else if (hasCutter && !cutter) {
          waiting.push(result)
        } else {
          handOver(result)
        }
        return result
      })
    )
    return { plan, workers: assembleWorkers(workers, request.edit.cuts, plan.chapters) }
  }

  /** One agent again, on the same sheet and plan, with a further instruction. */
  async rerun(sessionId: string, request: AutoEditRerunRequest, base: AiChoice): Promise<WorkerResult> {
    const facts = await this.factsOf(sessionId, request)
    const sheet = buildRecordingSheet(facts, request.brief)
    const result = await this.runWorker(sessionId, request.role, sheet, request.plan, facts, base, request.instruction)
    const [assembled] = assembleWorkers([result], request.edit.cuts, request.plan.chapters)
    return assembled ?? result
  }

  cancel(): void {
    this.deps.ai.cancel()
  }

  private async runWorker(sessionId: string, role: WorkerRole, sheet: string, plan: AutoEditPlan, facts: RecordingFacts, base: AiChoice, instruction: string): Promise<WorkerResult> {
    const startedAt = Date.now()
    this.deps.onProgress({ sessionId, who: role, stage: 'thinking', elapsedMs: 0 })
    try {
      const prompt = buildWorkerPrompt(role, sheet, plan, instruction)
      const answer = await this.deps.ai.ask(this.choiceFor(base, role), prompt)
      const { actions, notes } = parseWorkerResponse(answer, role, facts.words, facts.durationMs)
      const elapsedMs = Date.now() - startedAt
      this.deps.onProgress({ sessionId, who: role, stage: 'done', elapsedMs })
      this.deps.logger.info('agent done', { sessionId, role, actions: actions.length, elapsedMs })
      return { role, actions, notes, elapsedMs, error: null }
    } catch (error) {
      const failure = error instanceof AiError ? error.appError : appError('ai-failed', String(error))
      const elapsedMs = Date.now() - startedAt
      this.deps.onProgress({ sessionId, who: role, stage: 'failed', elapsedMs })
      if (failure.code === 'ai-cancelled') throw error
      this.deps.logger.warn('agent failed', { sessionId, role, code: failure.code, detail: failure.detail })
      return { role, actions: [], notes: '', elapsedMs, error: failure.message }
    }
  }

  /** The user's tool and model, at the effort the role calls for when the tool offers it. */
  private choiceFor(base: AiChoice, role: WorkerRole | 'director'): AiChoice {
    const wanted = ROLE_EFFORT[role]
    const efforts = AI_PROVIDER_SPECS[base.provider].efforts
    return { ...base, effort: efforts.includes(wanted) ? wanted : base.effort }
  }

  private async factsOf(sessionId: string, request: AutoEditRequest): Promise<RecordingFacts> {
    const manifest = await this.deps.sessions.read(sessionId)
    if (!manifest) throw new AiError(appError('ai-failed', 'session not found'))
    const transcript = parseTranscript(await this.readJson(sessionId, SESSION_FILES.transcript))
    const words: TranscriptWord[] = transcript?.words ?? []
    return {
      durationMs: request.edit.durationMs,
      words,
      locale: transcript?.locale ?? null,
      interactions: parseInteractions(await this.readJson(sessionId, SESSION_FILES.interactions)),
      cursor: parseCursorSamples(await this.readJson(sessionId, SESSION_FILES.cursor)),
      edit: request.edit,
      hasWebcam: manifest.assets.webcam !== undefined,
      hasMicrophone: manifest.assets.microphone !== undefined,
      hasSystemAudio: manifest.assets.systemAudio !== undefined,
      musicName: manifest.assets.music?.name ?? null,
      imageNames: (manifest.assets.images ?? []).map((image) => image.name),
      cursorDrawn: !manifest.capture.cursorInVideo && manifest.assets.cursor !== undefined,
      second: await this.secondVideoFacts(sessionId, request, manifest.assets.videos ?? [], transcript?.locale ?? 'pt-BR')
    }
  }

  /** The second video, its speech on the recording's clock, and what the user said each video is. */
  private async secondVideoFacts(
    sessionId: string,
    request: AutoEditRequest,
    clips: ReadonlyArray<{ file: string; durationMs: number; hasAudio?: boolean }>,
    locale: string
  ): Promise<SecondVideoFacts | null> {
    const second = request.edit.secondVideo
    if (!second) return null
    const clip = clips.find((candidate) => candidate.file === second.file)
    const words = clip?.hasAudio && this.deps.clipWords ? await this.deps.clipWords(sessionId, second.file, clip.durationMs, locale).catch(() => null) : null
    return {
      name: second.name,
      firstRole: request.brief.videoRoles?.first ?? '',
      secondRole: request.brief.videoRoles?.second ?? '',
      words: words ? wordsOnRecordingClock(words, second.pieces) : [],
      transcribed: words !== null
    }
  }

  private async readJson(sessionId: string, file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path.join(this.deps.sessions.directoryOf(sessionId), file), 'utf8'))
    } catch {
      return null
    }
  }
}
