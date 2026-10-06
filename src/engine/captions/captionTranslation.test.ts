import { describe, expect, it } from 'vitest'
import {
  TRANSLATION_CONFIG,
  buildTranslationPrompt,
  parseTranslationResponse,
  translationBatches,
  translationTargets
} from './captionTranslation'

const cues = [
  { id: 'cue-a', text: 'Olá  pessoal,' },
  { id: 'cue-b', text: 'hoje vamos exportar' },
  { id: 'cue-c', text: 'um vídeo.' }
]

describe('translationTargets', () => {
  it('offers every language but the one spoken', () => {
    expect(translationTargets('pt-BR')).toEqual(['en', 'es', 'zh'])
    expect(translationTargets('en-US')).toEqual(['es', 'zh', 'pt'])
    expect(translationTargets('zh-CN')).toEqual(['en', 'es', 'pt'])
    expect(translationTargets(null)).toEqual(['en', 'es', 'zh', 'pt'])
  })
})

describe('buildTranslationPrompt', () => {
  it('numbers the captions and names both languages', () => {
    const { system, prompt } = buildTranslationPrompt(cues, 'pt-BR', 'zh')
    expect(system).toContain('Simplified Chinese')
    expect(prompt).toContain('Language spoken: pt-BR')
    expect(prompt).toContain('0|Olá pessoal,\n1|hoje vamos exportar\n2|um vídeo.')
  })
})

describe('parseTranslationResponse', () => {
  it('files each translation under the id of its caption', () => {
    const answer = {
      translations: [
        { index: 1, text: 'today we will export' },
        { index: 0, text: ' Hello  everyone, ' },
        { index: 2, text: 'a video.' }
      ]
    }
    expect(parseTranslationResponse(answer, cues)).toEqual({
      'cue-a': 'Hello everyone,',
      'cue-b': 'today we will export',
      'cue-c': 'a video.'
    })
  })

  it('drops what is not a translation of one of the captions, keeping the first of a repeated one', () => {
    const answer = {
      translations: [
        { index: 0, text: '大家好，' },
        { index: 0, text: 'outra' },
        { index: 9, text: 'fora' },
        { index: 1.5, text: 'fração' },
        { index: 1, text: '   ' },
        { index: 2, text: 42 },
        'nonsense'
      ]
    }
    expect(parseTranslationResponse(answer, cues)).toEqual({ 'cue-a': '大家好，' })
  })

  it.each([null, 'x', {}, { translations: 'none' }])('returns nothing for %j', (answer) => {
    expect(parseTranslationResponse(answer, cues)).toEqual({})
  })
})

describe('translationBatches', () => {
  it('splits a long list and keeps the order', () => {
    const many = Array.from({ length: TRANSLATION_CONFIG.cuesPerRequest * 2 + 3 }, (_, index) => index)
    const batches = translationBatches(many)
    expect(batches.map((batch) => batch.length)).toEqual([150, 150, 3])
    expect(batches.flat()).toEqual(many)
    expect(translationBatches([])).toEqual([])
  })
})
