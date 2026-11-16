import type { AiEffort, AiModel, AiProviderId } from '@shared/models/ai'
import { isAiEffort, isAiModelId } from '@shared/models/ai'

/** What is fixed about each tool: its names, how it is installed, and what it accepts. */
export interface AiProviderSpec {
  label: string
  toolName: string
  binary: string
  /** The vendor's own install script, the one its site tells users to run. */
  installer: string
  /** The command that signs in, or `null` when the tool signs in on its first interactive run. */
  login: readonly string[] | null
  efforts: AiEffort[]
  defaultEffort: AiEffort
}

export const AI_PROVIDER_SPECS: Record<AiProviderId, AiProviderSpec> = {
  claude: {
    label: 'Claude',
    toolName: 'Claude Code',
    binary: 'claude',
    installer: 'https://claude.ai/install.sh',
    login: ['auth', 'login', '--claudeai'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium'
  },
  codex: {
    label: 'ChatGPT',
    toolName: 'Codex CLI',
    binary: 'codex',
    installer: 'https://chatgpt.com/codex/install.sh',
    login: ['login'],
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium'
  },
  agy: {
    label: 'Gemini',
    toolName: 'Antigravity CLI (Gemini)',
    binary: 'agy',
    installer: 'https://antigravity.google/cli/install.sh',
    login: null,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium'
  }
}

/** The account's own default: no model is named and the tool decides. */
export const ACCOUNT_DEFAULT_MODEL: AiModel = { id: '', label: 'Padrão da conta' }

/**
 * Claude Code's aliases, each pointing at the newest model of its family, as
 * its own `--help` documents them: what is offered while the tool has not
 * fetched its catalogue on this machine yet.
 */
export const CLAUDE_MODELS: AiModel[] = [
  { id: 'sonnet', label: 'Sonnet', description: 'Equilíbrio entre rapidez e qualidade (recomendado).' },
  { id: 'haiku', label: 'Haiku', description: 'O mais rápido.' },
  { id: 'opus', label: 'Opus', description: 'Mais capaz, mais lento.' },
  { id: 'fable', label: 'Fable', description: 'O mais capaz.' }
]

/** Codex's catalogue describes its models in English; the known descriptions are shown in Portuguese. */
const CODEX_DESCRIPTIONS: Record<string, string> = {
  'Latest workhorse model for coding and everyday work.': 'O mais recente para o trabalho do dia a dia.',
  'Frontier intelligence for the most demanding work.': 'O mais capaz, para o trabalho mais exigente.',
  'Previous generation workhorse model.': 'Geração anterior, para o trabalho do dia a dia.',
  'Fast and affordable model for easier tasks.': 'Rápido e econômico, para tarefas mais simples.',
  'Older generation workhorse model.': 'Geração mais antiga, para o trabalho do dia a dia.',
  'Older balanced model for straightforward work.': 'Geração anterior, equilibrado.',
  'Older fast and efficient model.': 'Geração anterior, rápido e eficiente.'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The models Codex offers this account, from the catalogue the tool keeps
 * in `~/.codex/models_cache.json`: in its own order, without the hidden ones.
 */
export function parseCodexCatalog(raw: unknown): AiModel[] {
  const entries = isRecord(raw) && Array.isArray(raw.models) ? raw.models.filter(isRecord) : []
  return entries
    .filter((entry) => isAiModelId(entry.slug) && entry.slug !== '' && entry.visibility !== 'hide')
    .sort((a, b) => (typeof a.priority === 'number' ? a.priority : 99) - (typeof b.priority === 'number' ? b.priority : 99))
    .map((entry) => {
      const slug = entry.slug as string
      const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
      const efforts = levels.map((level) => (isRecord(level) ? level.effort : null)).filter(isAiEffort)
      const name = typeof entry.display_name === 'string' ? entry.display_name : slug
      const description = typeof entry.description === 'string' ? entry.description.trim() : ''
      const model: AiModel = {
        id: slug,
        // "GPT-6.1-Sol" reads better as "GPT-6.1 Sol".
        label: name.replace(/^(GPT-[\d.]+)-/i, '$1 ').slice(0, 60)
      }
      if (description) model.description = (CODEX_DESCRIPTIONS[description] ?? description).slice(0, 200)
      if (efforts.length > 0) model.efforts = efforts
      if (isAiEffort(entry.default_reasoning_level) && efforts.includes(entry.default_reasoning_level)) {
        model.defaultEffort = entry.default_reasoning_level
      }
      return model
    })
}

/** The models Antigravity offers, from the output of `agy models`: one "id<TAB>name" per line. */
export function parseAgyModels(output: string): AiModel[] {
  const models: AiModel[] = []
  for (const line of output.split('\n')) {
    const match = /^([\w.:-]+)\t(.+)$/.exec(line.trim())
    const id = match?.[1]
    const label = match?.[2]?.trim()
    if (id && label && isAiModelId(id)) models.push({ id, label: label.slice(0, 60) })
  }
  return models
}

/** The effort a tool is actually asked for: each accepts a subset, and the rest maps to its nearest level. */
export function toolEffort(provider: AiProviderId, effort: AiEffort): string {
  if (provider === 'codex') return effort
  if (effort === 'minimal') return 'low'
  if (effort === 'ultra') return 'max'
  if (provider === 'agy' && effort === 'xhigh') return 'max'
  return effort
}

/**
 * The models Claude Code offers this account, from the catalogue the tool
 * itself fetches and keeps in `~/.claude/cache/model-catalog/<key>.json`:
 * the main ones first, then the rest, each with the effort levels it takes.
 * The file's `fetchedAt` says which of several is the newest.
 */
export function parseClaudeCatalog(raw: unknown): { fetchedAt: number; models: AiModel[] } | null {
  if (!isRecord(raw) || !isRecord(raw.catalog) || !isRecord(raw.catalog.config) || !Array.isArray(raw.catalog.config.models)) return null
  const entries = raw.catalog.config.models.filter(isRecord)
  const parse = (entry: Record<string, unknown>): AiModel | null => {
    if (!isAiModelId(entry.id) || entry.id === '') return null
    const runtime = isRecord(entry.runtime) ? entry.runtime : {}
    const options = isRecord(entry.thinking) && Array.isArray(entry.thinking.effort_options) ? entry.thinking.effort_options : []
    const fromOptions = options.map((option) => (isRecord(option) ? option.id : null)).filter(isAiEffort)
    const fromRuntime = Array.isArray(runtime.effort_levels) ? runtime.effort_levels.filter(isAiEffort) : []
    const efforts = fromOptions.length > 0 ? fromOptions : fromRuntime
    const model: AiModel = { id: entry.id, label: (typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id).slice(0, 60) }
    if (typeof entry.description === 'string' && entry.description.trim()) model.description = entry.description.trim().slice(0, 200)
    if (efforts.length > 0) model.efforts = efforts
    if (isAiEffort(runtime.default_effort) && efforts.includes(runtime.default_effort)) model.defaultEffort = runtime.default_effort
    return model
  }
  const main = entries.filter((entry) => entry.section === 'main').map(parse)
  const rest = entries.filter((entry) => entry.section !== 'main').map(parse)
  const models = [...main, ...rest].filter((model): model is AiModel => model !== null)
  return { fetchedAt: typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0, models }
}
