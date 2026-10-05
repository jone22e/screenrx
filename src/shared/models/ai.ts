/**
 * The AI command-line tools the app can drive (Claude Code, Codex,
 * Antigravity), what each offers — models, effort levels — and the user's choice among them.
 */

export type AiProviderId = 'claude' | 'codex' | 'agy'

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ['claude', 'codex', 'agy']

export function isAiProviderId(value: unknown): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly unknown[]).includes(value)
}

/** How much reasoning the model spends, from least to most; each tool accepts a subset. */
export type AiEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export const AI_EFFORTS: readonly AiEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export const AI_EFFORT_LABELS: Record<AiEffort, string> = {
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Extra alto',
  max: 'Máximo',
  ultra: 'Ultra'
}

export function isAiEffort(value: unknown): value is AiEffort {
  return (AI_EFFORTS as readonly unknown[]).includes(value)
}

export interface AiModel {
  /** What the tool is asked for; empty means "the account's default model". */
  id: string
  label: string
  description?: string
  /** Effort levels this model accepts; absent means the tool's own defaults. */
  efforts?: AiEffort[]
  defaultEffort?: AiEffort
}

/** One tool as it stands on this machine. */
export interface AiProvider {
  id: AiProviderId
  label: string
  /** Name of the tool itself, as the user installs it. */
  toolName: string
  installed: boolean
  version: string | null
  loggedIn: boolean
  /** Who is signed in, when the tool says. */
  account: string | null
  /** Whether the app can start the sign-in itself; otherwise the tool signs in on its first run in a terminal. */
  canLogIn: boolean
  /** Models to choose from; the first is the default. */
  models: AiModel[]
  /** Effort levels of a model that does not list its own. */
  efforts: AiEffort[]
  defaultEffort: AiEffort
}

/** Which tool to ask, with which model, thinking how hard. */
export interface AiChoice {
  provider: AiProviderId
  model: string
  effort: AiEffort
}

/** A model id is passed to a command line: only plain identifiers are accepted. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export function isAiModelId(value: unknown): value is string {
  return value === '' || (typeof value === 'string' && MODEL_ID.test(value))
}

export function parseAiChoice(value: unknown): AiChoice | null {
  if (typeof value !== 'object' || value === null) return null
  const { provider, model, effort } = value as Record<string, unknown>
  return isAiProviderId(provider) && isAiModelId(model) && isAiEffort(effort) ? { provider, model, effort } : null
}

/** What the user picked last time, per tool; anything may be missing or out of date. */
export interface AiPreferences {
  provider: AiProviderId | null
  model: Partial<Record<AiProviderId, string>>
  effort: Partial<Record<AiProviderId, AiEffort>>
}

export const EMPTY_AI_PREFERENCES: AiPreferences = { provider: null, model: {}, effort: {} }

/** Preferences as they come back from storage: whatever is not well-formed is simply forgotten. */
export function parseAiPreferences(value: unknown): AiPreferences {
  const record = (candidate: unknown): Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : {}
  const saved = record(value)
  const models = record(saved['model'])
  const efforts = record(saved['effort'])
  const preferences: AiPreferences = {
    provider: isAiProviderId(saved['provider']) ? saved['provider'] : null,
    model: {},
    effort: {}
  }
  for (const id of AI_PROVIDER_IDS) {
    const model = models[id]
    const effort = efforts[id]
    if (isAiModelId(model)) preferences.model[id] = model
    if (isAiEffort(effort)) preferences.effort[id] = effort
  }
  return preferences
}

/** Effort levels offered for a model of a provider. */
export function effortsOf(provider: AiProvider, modelId: string): AiEffort[] {
  const model = provider.models.find((candidate) => candidate.id === modelId)
  return model?.efforts?.length ? model.efforts : provider.efforts
}

/**
 * The choice for one provider: the preferred model and effort when the tool
 * still offers them, its defaults otherwise.
 */
export function choiceFor(provider: AiProvider, preferences: AiPreferences): AiChoice {
  const preferred = preferences.model[provider.id]
  const model = provider.models.find((candidate) => candidate.id === preferred) ?? provider.models[0]
  const modelId = model?.id ?? ''
  const efforts = effortsOf(provider, modelId)
  const wanted = preferences.effort[provider.id]
  const effort =
    wanted && efforts.includes(wanted)
      ? wanted
      : model?.defaultEffort && efforts.includes(model.defaultEffort)
        ? model.defaultEffort
        : efforts.includes(provider.defaultEffort)
          ? provider.defaultEffort
          : (efforts[0] ?? provider.defaultEffort)
  return { provider: provider.id, model: modelId, effort }
}

/**
 * The tool to use: the preferred one when it is ready (installed and signed
 * in), otherwise the first that is. `null` when none is.
 */
export function readyProvider(providers: readonly AiProvider[], preferences: AiPreferences): AiProvider | null {
  const ready = providers.filter((provider) => provider.installed && provider.loggedIn)
  return ready.find((provider) => provider.id === preferences.provider) ?? ready[0] ?? null
}
