import { describe, expect, it } from 'vitest'
import { parseAgyModels, parseClaudeCatalog, parseCodexCatalog, toolEffort } from './aiCatalog'

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

describe('parseClaudeCatalog', () => {
  const catalog = {
    version: 2,
    fetchedAt: 1794853198455,
    catalog: {
      surface: 'ccd',
      config: {
        models: [
          { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'overflow', runtime: { effort_levels: ['low', 'medium', 'high'], default_effort: 'medium' } },
          {
            id: 'claude-opus-5-5',
            name: 'Opus 5.5',
            section: 'main',
            description: 'For complex work and everyday tasks',
            thinking: { type: 'effort', effort_options: [{ id: 'low' }, { id: 'medium' }, { id: 'turbo' }, { id: 'max' }] },
            runtime: { effort_levels: ['low', 'medium', 'max'], default_effort: 'medium' }
          },
          { id: '--model evil', name: 'Bad', section: 'main' },
          'nonsense'
        ]
      }
    }
  }

  it('lists the main models first, then the rest, with the effort levels the tool names', () => {
    expect(parseClaudeCatalog(catalog)).toEqual({
      fetchedAt: 1794853198455,
      models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'For complex work and everyday tasks', efforts: ['low', 'medium', 'max'], defaultEffort: 'medium' },
        { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }
      ]
    })
  })

  it.each([null, 'x', {}, { catalog: { config: { models: 'none' } } }])('returns nothing for %j', (raw) => {
    expect(parseClaudeCatalog(raw)).toBeNull()
  })
})
