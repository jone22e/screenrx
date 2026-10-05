import { describe, expect, it } from 'vitest'
import type { TranscriptWord } from '@shared/models/captions'
import {
  CUT_SUGGESTION_CONFIG,
  addCut,
  buildCutPrompt,
  isCoveredByCuts,
  parseCutResponse
} from './cutSuggestions'

/** Evenly spaced words, 400 ms each. */
const speech = (text: string): TranscriptWord[] =>
  text.split(' ').map((part, index) => ({ text: part, startMs: index * 400, endMs: (index + 1) * 400 }))

const ids = (): (() => string) => {
  let next = 0
  return () => `suggestion-${next++}`
}

const words = speech('Olá pessoal, hoje eu é hum de novo. Olá pessoal, hoje vamos exportar.')
const durationMs = 5200

describe('buildCutPrompt', () => {
  it('numbers the words and marks the pauses between them', () => {
    const paused: TranscriptWord[] = [
      { text: 'um', startMs: 0, endMs: 300 },
      { text: 'dois', startMs: 300, endMs: 3000 },
      { text: 'três', startMs: 3000, endMs: 3300 }
    ]
    const { prompt, wordCount } = buildCutPrompt(paused, 'pt-BR')
    expect(prompt).toContain('pt-BR')
    expect(prompt).toContain('0 um\n1 dois\n-- pause 2.7s --\n2 três')
    expect(wordCount).toBe(3)
  })

  it('analyses a very long transcript only up to the limit', () => {
    const long = Array.from({ length: CUT_SUGGESTION_CONFIG.maxWords + 50 }, (_, index) => ({
      text: 'a',
      startMs: index * 100,
      endMs: (index + 1) * 100
    }))
    const { prompt, wordCount } = buildCutPrompt(long, 'pt-BR')
    expect(wordCount).toBe(CUT_SUGGESTION_CONFIG.maxWords)
    expect(prompt).not.toContain(`\n${CUT_SUGGESTION_CONFIG.maxWords} a`)
  })
})

describe('parseCutResponse', () => {
  it('turns word spans into cuts that end where the next word begins', () => {
    const answer = { cuts: [{ fromWord: 0, toWord: 7, kind: 'retake', reason: 'Começo abandonado e repetido logo depois.' }] }
    expect(parseCutResponse(answer, words, durationMs, ids())).toEqual([
      {
        id: 'suggestion-0',
        startMs: 0,
        endMs: 3200,
        kind: 'retake',
        reason: 'Começo abandonado e repetido logo depois.',
        text: 'Olá pessoal, hoje eu é hum de novo.'
      }
    ])
  })

  it('ends a cut of the last words where the speech ends, within the recording', () => {
    const answer = { cuts: [{ fromWord: 11, toWord: 12, kind: 'off-topic', reason: 'x' }] }
    const [cut] = parseCutResponse(answer, words, 5000, ids())
    expect(cut).toMatchObject({ startMs: 4400, endMs: 5000, text: 'vamos exportar.' })
  })

  it('drops everything that is not a valid span of the transcript', () => {
    const answer = {
      cuts: [
        { fromWord: 5, toWord: 3, kind: 'filler', reason: 'invertido' },
        { fromWord: -1, toWord: 2, kind: 'filler', reason: 'negativo' },
        { fromWord: 2, toWord: 99, kind: 'filler', reason: 'fora' },
        { fromWord: 1.5, toWord: 2, kind: 'filler', reason: 'fração' },
        { fromWord: '1', toWord: 2, kind: 'filler', reason: 'texto' },
        'not a cut',
        { fromWord: 4, toWord: 5, kind: 'filler', reason: 'válido' }
      ]
    }
    expect(parseCutResponse(answer, words, durationMs, ids()).map((cut) => cut.reason)).toEqual(['válido'])
  })

  it('sorts the cuts and drops one that overlaps an earlier one', () => {
    const answer = {
      cuts: [
        { fromWord: 8, toWord: 9, kind: 'filler', reason: 'depois' },
        { fromWord: 0, toWord: 3, kind: 'retake', reason: 'antes' },
        { fromWord: 2, toWord: 5, kind: 'filler', reason: 'sobreposto' }
      ]
    }
    expect(parseCutResponse(answer, words, durationMs, ids()).map((cut) => cut.reason)).toEqual(['antes', 'depois'])
  })

  it('repairs an unknown kind, a missing reason and an overlong one', () => {
    const answer = {
      cuts: [
        { fromWord: 0, toWord: 1, kind: 'explode' },
        { fromWord: 4, toWord: 5, kind: 'filler', reason: 'x'.repeat(900) }
      ]
    }
    const [first, second] = parseCutResponse(answer, words, durationMs, ids())
    expect(first).toMatchObject({ kind: 'retake', reason: '' })
    expect(second?.reason).toHaveLength(CUT_SUGGESTION_CONFIG.maxReasonLength)
  })

  it.each([null, 'cuts', 42, {}, { cuts: 'none' }, { cuts: [] }])('returns nothing for %j', (answer) => {
    expect(parseCutResponse(answer, words, durationMs, ids())).toEqual([])
  })
})

describe('isCoveredByCuts', () => {
  const trims = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 6000 }
  ]

  it('is true only when one cut removes the whole span', () => {
    expect(isCoveredByCuts({ startMs: 1200, endMs: 1800 }, trims)).toBe(true)
    expect(isCoveredByCuts({ startMs: 1000, endMs: 2000 }, trims)).toBe(true)
    expect(isCoveredByCuts({ startMs: 1500, endMs: 2500 }, trims)).toBe(false)
    expect(isCoveredByCuts({ startMs: 3000, endMs: 4000 }, trims)).toBe(false)
    expect(isCoveredByCuts({ startMs: 3000, endMs: 4000 }, [])).toBe(false)
  })
})

describe('addCut', () => {
  it('adds a cut in order', () => {
    expect(addCut([{ startMs: 5000, endMs: 6000 }], { startMs: 1000, endMs: 2000 })).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 5000, endMs: 6000 }
    ])
  })

  it('absorbs the cuts it touches', () => {
    const trims = [
      { startMs: 1000, endMs: 2000 },
      { startMs: 2500, endMs: 3000 },
      { startMs: 8000, endMs: 9000 }
    ]
    expect(addCut(trims, { startMs: 1800, endMs: 2500 })).toEqual([
      { startMs: 1000, endMs: 3000 },
      { startMs: 8000, endMs: 9000 }
    ])
  })
})
