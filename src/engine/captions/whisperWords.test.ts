import { describe, expect, it } from 'vitest'
import { captionLocaleOfLanguage, parseVerboseTranscription, whisperLanguageOf, wordsFromTranscription } from './whisperWords'

describe('parseVerboseTranscription', () => {
  it('reads the language, the words and the segments', () => {
    const parsed = parseVerboseTranscription({
      language: 'portuguese',
      words: [{ word: 'Olá', start: 0.1, end: 0.4 }],
      segments: [{ start: 0, end: 1, text: ' Olá.' }]
    })
    expect(parsed).toEqual({ language: 'portuguese', words: [{ word: 'Olá', start: 0.1, end: 0.4 }], segments: [{ start: 0, end: 1, text: ' Olá.' }] })
  })

  it('accepts an answer without words or segments', () => {
    expect(parseVerboseTranscription({ text: 'nothing timed' })).toEqual({ language: null, words: [], segments: [] })
  })

  it('refuses malformed words', () => {
    expect(parseVerboseTranscription({ words: [{ word: 1, start: 0, end: 1 }] })).toBeNull()
    expect(parseVerboseTranscription({ words: [{ word: 'a', start: -1, end: 1 }] })).toBeNull()
    expect(parseVerboseTranscription(null)).toBeNull()
  })
})

describe('wordsFromTranscription', () => {
  it('takes the punctuation from the segments when the words match', () => {
    const words = wordsFromTranscription(
      {
        language: 'pt',
        words: [
          { word: 'Olá', start: 0, end: 0.3 },
          { word: 'pessoal', start: 0.3, end: 0.8 },
          { word: 'Hoje', start: 1, end: 1.3 },
          { word: 'sim', start: 1.3, end: 1.6 }
        ],
        segments: [
          { start: 0, end: 0.9, text: ' Olá, pessoal.' },
          { start: 1, end: 1.7, text: 'Hoje sim!' }
        ]
      },
      500
    )
    expect(words).toEqual([
      { text: 'Olá,', startMs: 500, endMs: 800 },
      { text: 'pessoal.', startMs: 800, endMs: 1300 },
      { text: 'Hoje', startMs: 1500, endMs: 1800 },
      { text: 'sim!', startMs: 1800, endMs: 2100 }
    ])
  })

  it('keeps the words as given when a segment does not line up', () => {
    const words = wordsFromTranscription({
      language: null,
      words: [
        { word: 'one', start: 0, end: 0.2 },
        { word: 'two', start: 0.2, end: 0.4 }
      ],
      segments: [{ start: 0, end: 0.5, text: 'one two three' }]
    })
    expect(words.map((word) => word.text)).toEqual(['one', 'two'])
  })

  it('falls back to the segments when the service gives no word times', () => {
    const words = wordsFromTranscription({
      language: null,
      words: [],
      segments: [
        { start: 0, end: 2, text: ' First sentence. ' },
        { start: 2, end: 4, text: 'Second one.' }
      ]
    })
    expect(words).toEqual([
      { text: 'First sentence.', startMs: 0, endMs: 2000 },
      { text: 'Second one.', startMs: 2000, endMs: 4000 }
    ])
  })
})

describe('languages', () => {
  it('sends the ISO code for the locale', () => {
    expect(whisperLanguageOf('pt-BR')).toBe('pt')
    expect(whisperLanguageOf('zh-CN')).toBe('zh')
  })

  it('maps what the services answer back to a locale of the editor', () => {
    expect(captionLocaleOfLanguage('portuguese')).toBe('pt-BR')
    expect(captionLocaleOfLanguage('pt')).toBe('pt-BR')
    expect(captionLocaleOfLanguage('en')).toBe('en-US')
    expect(captionLocaleOfLanguage('English')).toBe('en-US')
    expect(captionLocaleOfLanguage('es-MX')).toBe('es-MX')
    expect(captionLocaleOfLanguage('Chinese')).toBe('zh-CN')
    expect(captionLocaleOfLanguage('swahili')).toBeNull()
  })
})
