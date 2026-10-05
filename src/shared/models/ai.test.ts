import { describe, expect, it } from 'vitest'
import type { AiProvider } from './ai'
import {
  EMPTY_AI_PREFERENCES,
  choiceFor,
  effortsOf,
  isAiModelId,
  parseAiChoice,
  parseAiPreferences,
  readyProvider
} from './ai'

const claude: AiProvider = {
  id: 'claude',
  label: 'Claude',
  toolName: 'Claude Code',
  installed: true,
  version: '2.1.0',
  loggedIn: true,
  account: null,
  canLogIn: true,
  models: [
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' }
  ],
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium'
}

const codex: AiProvider = {
  id: 'codex',
  label: 'ChatGPT',
  toolName: 'Codex CLI',
  installed: true,
  version: '0.160.0',
  loggedIn: true,
  account: null,
  canLogIn: true,
  models: [
    { id: '', label: 'Padrão da conta' },
    { id: 'gpt-fast', label: 'GPT Fast', efforts: ['low', 'high'], defaultEffort: 'low' }
  ],
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium'
}

describe('isAiModelId', () => {
  it.each(['', 'sonnet', 'claude-fable-5-1', 'gpt-6.1-sol', 'a:b_c'])('accepts %j', (id) => {
    expect(isAiModelId(id)).toBe(true)
  })

  it.each(['--dangerous', '-m', 'a b', 'a;rm', 'x'.repeat(65), 42, null])('rejects %j', (id) => {
    expect(isAiModelId(id)).toBe(false)
  })
})

describe('parseAiChoice', () => {
  it('accepts a well-formed choice and nothing else', () => {
    expect(parseAiChoice({ provider: 'claude', model: 'sonnet', effort: 'high', extra: 1 })).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high'
    })
    expect(parseAiChoice({ provider: 'ollama', model: 'x', effort: 'high' })).toBeNull()
    expect(parseAiChoice({ provider: 'claude', model: '--print', effort: 'high' })).toBeNull()
    expect(parseAiChoice({ provider: 'claude', model: 'sonnet', effort: 'huge' })).toBeNull()
    expect(parseAiChoice('claude')).toBeNull()
  })
})

describe('parseAiPreferences', () => {
  it('keeps what is well-formed and forgets the rest', () => {
    const saved = {
      provider: 'agy',
      model: { claude: 'haiku', codex: '--evil', agy: '', other: 'x' },
      effort: { claude: 'high', codex: 'huge' },
      extra: true
    }
    expect(parseAiPreferences(saved)).toEqual({
      provider: 'agy',
      model: { claude: 'haiku', agy: '' },
      effort: { claude: 'high' }
    })
  })

  it.each([null, 'x', 42, { provider: 'ollama', model: 'sonnet' }])('starts empty from %j', (saved) => {
    expect(parseAiPreferences(saved)).toEqual(EMPTY_AI_PREFERENCES)
  })
})

describe('effortsOf', () => {
  it("uses a model's own levels, or the provider's", () => {
    expect(effortsOf(codex, 'gpt-fast')).toEqual(['low', 'high'])
    expect(effortsOf(codex, '')).toEqual(['low', 'medium', 'high'])
    expect(effortsOf(codex, 'unknown')).toEqual(['low', 'medium', 'high'])
  })
})

describe('choiceFor', () => {
  it('starts from the defaults', () => {
    expect(choiceFor(claude, EMPTY_AI_PREFERENCES)).toEqual({ provider: 'claude', model: 'sonnet', effort: 'medium' })
    expect(choiceFor(codex, EMPTY_AI_PREFERENCES)).toEqual({ provider: 'codex', model: '', effort: 'medium' })
  })

  it('keeps what the user picked while the tool still offers it', () => {
    const preferences = { provider: null, model: { claude: 'haiku' }, effort: { claude: 'high' as const } }
    expect(choiceFor(claude, preferences)).toEqual({ provider: 'claude', model: 'haiku', effort: 'high' })
  })

  it('falls back when the model is gone or does not accept the effort', () => {
    expect(choiceFor(claude, { provider: null, model: { claude: 'retired' }, effort: {} }).model).toBe('sonnet')
    // "medium" is not a level of this model: its own default is used.
    const preferences = { provider: null, model: { codex: 'gpt-fast' }, effort: { codex: 'medium' as const } }
    expect(choiceFor(codex, preferences)).toEqual({ provider: 'codex', model: 'gpt-fast', effort: 'low' })
  })
})

describe('readyProvider', () => {
  it('prefers the chosen tool, when it is installed and signed in', () => {
    expect(readyProvider([claude, codex], { ...EMPTY_AI_PREFERENCES, provider: 'codex' })?.id).toBe('codex')
    expect(readyProvider([claude, { ...codex, loggedIn: false }], { ...EMPTY_AI_PREFERENCES, provider: 'codex' })?.id).toBe('claude')
    expect(readyProvider([{ ...claude, installed: false, loggedIn: false }, codex], EMPTY_AI_PREFERENCES)?.id).toBe('codex')
  })

  it('is null when no tool is ready', () => {
    expect(readyProvider([{ ...claude, loggedIn: false }, { ...codex, installed: false }], EMPTY_AI_PREFERENCES)).toBeNull()
  })
})
