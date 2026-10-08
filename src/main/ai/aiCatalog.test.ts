import { describe, expect, it } from 'vitest'
import { claudeModelLabel, claudeModelsSeen, parseAgyModels, parseClaudeSessionModels, parseCodexCatalog, toolEffort } from './aiCatalog'

describe('parseCodexCatalog', () => {
  const catalog = {
    models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 4, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'warp' }], description: 'Fast and affordable model for easier tasks.' },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 1 },
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], description: 'Something new.' },
      { slug: '--model evil', display_name: 'Bad' },
      'nonsense'
    ]
  }

  it('lists the visible models in the catalogue order, with their effort levels', () => {
    expect(parseCodexCatalog(catalog)).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: 'Something new.', efforts: ['low', 'ultra'], defaultEffort: 'low' },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        description: 'Rápido e econômico, para tarefas mais simples.',
        efforts: ['low', 'medium'],
        defaultEffort: 'medium'
      }
    ])
  })

  it.each([null, 'x', {}, { models: 'none' }])('returns nothing for %j', (raw) => {
    expect(parseCodexCatalog(raw)).toEqual([])
  })
})

describe('parseAgyModels', () => {
  it('reads the id and the name of each model, ignoring everything else', () => {
    const output = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\nnot a model line\n'
    expect(parseAgyModels(output)).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' }
    ])
  })
})

describe('toolEffort', () => {
  it('maps a level a tool does not have to its nearest one', () => {
    expect(toolEffort('claude', 'minimal')).toBe('low')
    expect(toolEffort('claude', 'xhigh')).toBe('xhigh')
    expect(toolEffort('claude', 'ultra')).toBe('max')
    expect(toolEffort('agy', 'xhigh')).toBe('max')
    expect(toolEffort('codex', 'ultra')).toBe('ultra')
    expect(toolEffort('codex', 'minimal')).toBe('minimal')
  })
})

describe('Claude models from session logs', () => {
  it('finds the model ids an answer names, once each', () => {
    const log = [
      '{"type":"assistant","message":{"model":"claude-fable-5-1","content":[]}}',
      '{"type":"user","message":{"role":"user"}}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5-5"}}',
      '{"type":"assistant","message":{"model":"claude-fable-5-1"}}',
      '{"type":"assistant","message":{"model":"gpt-6"}}'
    ].join('\n')
    expect(parseClaudeSessionModels(log)).toEqual(['claude-fable-5-1', 'claude-sonnet-5-5'])
  })

  it('labels an id by family and version', () => {
    expect(claudeModelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(claudeModelLabel('claude-opus-5')).toBe('Opus 5')
    expect(claudeModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5 (20251001)')
    expect(claudeModelLabel('claude-nova-7')).toBe('Nova 7')
    expect(claudeModelLabel('something-else')).toBe('something-else')
  })

  it('offers the most recently used first', () => {
    const models = claudeModelsSeen(new Map([['claude-opus-5', 10], ['claude-fable-5-1', 30], ['claude-sonnet-5-5', 20]]))
    expect(models.map((model) => model.id)).toEqual(['claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-5'])
    expect(models[0]).toEqual({ id: 'claude-fable-5-1', label: 'Fable 5.1' })
  })
})
