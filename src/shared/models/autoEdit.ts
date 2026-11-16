import type { AssistantAction, AssistantEditState } from './assistant'
import { parseAssistantRequest } from './assistant'
import type { CaptionMode, ExportPreset } from './project'
import { isExportPreset } from './project'

/**
 * The automatic edit: a director plans, a team of agents edits in parallel,
 * each owning its own lanes, and the editor applies each agent's work as
 * one undo step. Only text goes to the AI tools.
 */

/** The agents, each with the lanes it owns. */
export type WorkerRole = 'cutter' | 'camera' | 'captioner' | 'sound' | 'art'
export const WORKER_ROLES: readonly WorkerRole[] = ['cutter', 'camera', 'captioner', 'sound', 'art']
export const isWorkerRole = (value: unknown): value is WorkerRole => (WORKER_ROLES as readonly unknown[]).includes(value)

/** What the user asks for before the team starts. */
export interface AutoEditBrief {
  preset: ExportPreset
  /** How long the finished video should be, in seconds; `null` for "as long as it needs". */
  targetDurationSec: number | null
  /** The feel, in the user's words ("tutorial direto", "bastidores descontraído"). */
  tone: string
  roles: WorkerRole[]
}

export interface AutoEditChapter {
  startMs: number
  endMs: number
  title: string
}

/** What the director decided. */
export interface AutoEditPlan {
  summary: string
  chapters: AutoEditChapter[]
  preset: ExportPreset
  targetDurationSec: number | null
  captionMode: CaptionMode
  workers: Array<{ role: WorkerRole; brief: string }>
}

/** One edit an agent asks for, and why. */
export interface WorkerAction {
  action: AssistantAction
  reason: string
}

export interface WorkerResult {
  role: WorkerRole
  actions: WorkerAction[]
  notes: string
  elapsedMs: number
  /** Why the agent produced nothing, when it failed. */
  error: string | null
}

export interface AutoEditResult {
  plan: AutoEditPlan
  workers: WorkerResult[]
}

export type AutoEditStage = 'thinking' | 'done' | 'failed'

export interface AutoEditProgress {
  sessionId: string
  who: WorkerRole | 'director'
  stage: AutoEditStage
  elapsedMs: number
}

export interface AutoEditRequest {
  brief: AutoEditBrief
  edit: AssistantEditState
}

/** Running one agent again, with the plan it worked from and something more from the user. */
export interface AutoEditRerunRequest extends AutoEditRequest {
  role: WorkerRole
  plan: AutoEditPlan
  instruction: string
}

export const AUTO_EDIT_LIMITS = { maxToneLength: 200, maxInstructionLength: 500, maxTargetSec: 4 * 3600, maxActionsPerWorker: 60, maxChapters: 40 } as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseBrief(value: unknown): AutoEditBrief | null {
  if (!isRecord(value)) return null
  const roles = Array.isArray(value.roles) ? value.roles.filter(isWorkerRole) : []
  if (roles.length === 0) return null
  const target = value.targetDurationSec
  return {
    preset: isExportPreset(value.preset) ? value.preset : 'custom',
    targetDurationSec: typeof target === 'number' && Number.isFinite(target) && target > 0 ? Math.min(target, AUTO_EDIT_LIMITS.maxTargetSec) : null,
    tone: typeof value.tone === 'string' ? value.tone.replace(/\s+/g, ' ').trim().slice(0, AUTO_EDIT_LIMITS.maxToneLength) : '',
    roles: [...new Set(roles)]
  }
}

export function parseAutoEditRequest(value: unknown): AutoEditRequest | null {
  if (!isRecord(value)) return null
  const brief = parseBrief(value.brief)
  // The edit state is checked as the assistant's is, on a stand-in message.
  const request = parseAssistantRequest({ message: 'auto', history: [], edit: value.edit })
  if (!brief || !request) return null
  return { brief, edit: request.edit }
}

export function parsePlan(value: unknown): AutoEditPlan | null {
  if (!isRecord(value) || !Array.isArray(value.chapters) || !Array.isArray(value.workers)) return null
  const chapters: AutoEditChapter[] = []
  for (const entry of value.chapters.slice(0, AUTO_EDIT_LIMITS.maxChapters)) {
    if (!isRecord(entry) || typeof entry.startMs !== 'number' || typeof entry.endMs !== 'number' || typeof entry.title !== 'string') continue
    chapters.push({ startMs: entry.startMs, endMs: entry.endMs, title: entry.title.slice(0, 80) })
  }
  const workers: AutoEditPlan['workers'] = []
  for (const entry of value.workers) {
    if (!isRecord(entry) || !isWorkerRole(entry.role) || typeof entry.brief !== 'string') continue
    workers.push({ role: entry.role, brief: entry.brief.slice(0, 3000) })
  }
  return {
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 1000) : '',
    chapters,
    preset: isExportPreset(value.preset) ? value.preset : 'custom',
    targetDurationSec: typeof value.targetDurationSec === 'number' && Number.isFinite(value.targetDurationSec) ? value.targetDurationSec : null,
    captionMode: value.captionMode === 'highlight' || value.captionMode === 'reveal' ? value.captionMode : 'block',
    workers
  }
}

export function parseAutoEditRerunRequest(value: unknown): AutoEditRerunRequest | null {
  const base = parseAutoEditRequest(value)
  if (!base || !isRecord(value) || !isWorkerRole(value.role)) return null
  const plan = parsePlan(value.plan)
  if (!plan) return null
  return {
    ...base,
    role: value.role,
    plan,
    instruction: typeof value.instruction === 'string' ? value.instruction.replace(/\s+/g, ' ').trim().slice(0, AUTO_EDIT_LIMITS.maxInstructionLength) : ''
  }
}
