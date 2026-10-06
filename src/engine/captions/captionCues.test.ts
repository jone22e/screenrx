import { describe, expect, it } from 'vitest'
import type { TranscriptWord } from '@shared/models/captions'
import { createCaptionSettings } from '@shared/models/project'
import { buildCues, captionAt, cueAt, cueText, normalizeWords } from './captionCues'

const word = (text: string, startMs: number, endMs: number): TranscriptWord => ({ text, startMs, endMs })

/** Evenly spaced words, 300 ms each, starting at `startMs`. */
const speech = (text: string, startMs = 0): TranscriptWord[] =>
  text.split(' ').map((part, index) => word(part, startMs + index * 300, startMs + (index + 1) * 300))

const ids = (): (() => string) => {
  let next = 0
  return () => `cue-${next++}`
}

describe('normalizeWords', () => {
  it('trims the spacing a recognizer leaves around words', () => {
    expect(normalizeWords([word('Olá', 0, 400), word(' pessoal,', 400, 900)])).toEqual([
      word('Olá', 0, 400),
      word('pessoal,', 400, 900)
    ])
  })

  it('joins loose punctuation to the word before it', () => {
    expect(normalizeWords([word('certo', 0, 400), word(' ?', 400, 450), word('sim', 450, 700)])).toEqual([
      word('certo?', 0, 450),
      word('sim', 450, 700)
    ])
  })

  it('drops empty entries and punctuation with nothing before it', () => {
    expect(normalizeWords([word('  ', 0, 100), word('…', 100, 200), word('oi', 200, 300)])).toEqual([
      word('oi', 200, 300)
    ])
  })

  it('puts words in time order and removes overlaps', () => {
    expect(normalizeWords([word('dois', 380, 700), word('um', 0, 400)])).toEqual([
      word('um', 0, 400),
      word('dois', 400, 700)
    ])
  })
})

describe('buildCues', () => {
  it('fills each caption up to the length limit', () => {
    const cues = buildCues(speech('um dois tres quatro cinco seis sete oito nove dez onze doze'), 'medium', ids())
    expect(cues.map((cue) => cue.text)).toEqual(['um dois tres quatro cinco seis sete oito', 'nove dez onze doze'])
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(42)
  })

  it('makes shorter captions when asked to', () => {
    const cues = buildCues(speech('um dois tres quatro cinco seis'), 'short', ids())
    expect(cues.map((cue) => cue.text)).toEqual(['um dois tres', 'quatro cinco seis'])
  })

  it('ends a caption at the end of a sentence', () => {
    const cues = buildCues(speech('Tudo certo. Vamos lá'), 'medium', ids())
    expect(cues.map((cue) => cue.text)).toEqual(['Tudo certo.', 'Vamos lá'])
  })

  it('ends a caption at a pause and does not hold it through the silence', () => {
    // The recognizer stretches "agora" over the silence that follows it.
    const words = [word('e', 0, 200), word('agora', 200, 6000), word('continua', 6000, 6500)]
    const cues = buildCues(words, 'medium', ids())
    expect(cues).toEqual([
      { id: 'cue-0', startMs: 0, endMs: 2200, text: 'e agora' },
      { id: 'cue-1', startMs: 6000, endMs: 6500, text: 'continua' }
    ])
  })

  it('keeps captions in order without overlapping', () => {
    const cues = buildCues(speech('a b c. d e f. g h i. j k l'), 'short', ids())
    for (let index = 1; index < cues.length; index++) {
      expect(cues[index]?.startMs).toBeGreaterThanOrEqual(cues[index - 1]?.endMs ?? Infinity)
    }
  })

  it('gives a word longer than the limit a caption of its own', () => {
    const cues = buildCues(speech('oi pneumoultramicroscopicossilicovulcanoconiótico fim'), 'short', ids())
    expect(cues.map((cue) => cue.text)).toEqual(['oi', 'pneumoultramicroscopicossilicovulcanoconiótico', 'fim'])
  })

  it('returns nothing for a transcript without words', () => {
    expect(buildCues([], 'medium', ids())).toEqual([])
  })
})

describe('cueAt', () => {
  const cues = [
    { id: 'a', startMs: 0, endMs: 1000, text: 'a' },
    { id: 'b', startMs: 1000, endMs: 2000, text: 'b' },
    { id: 'c', startMs: 5000, endMs: 6000, text: 'c' }
  ]

  it.each([
    [0, 'a'],
    [999, 'a'],
    [1000, 'b'],
    [1999, 'b'],
    [5500, 'c']
  ])('finds the caption at %d ms', (timeMs, id) => {
    expect(cueAt(cues, timeMs)?.id).toBe(id)
  })

  it.each([2000, 3000, 4999, 6000, 99_000, -1])('finds nothing at %d ms', (timeMs) => {
    expect(cueAt(cues, timeMs)).toBeNull()
  })

  it('finds nothing when there are no captions', () => {
    expect(cueAt([], 100)).toBeNull()
  })
})

describe('captionAt', () => {
  const cues = [
    { id: 'a', startMs: 0, endMs: 1000, text: 'Olá, pessoal.' },
    { id: 'b', startMs: 1000, endMs: 2000, text: 'Vamos exportar.' }
  ]
  const captions = { ...createCaptionSettings(), cues, translations: { zh: { a: '大家好。' } } }

  it('shows what was spoken when no language is chosen', () => {
    expect(captionAt(captions, 500)).toBe('Olá, pessoal.')
    expect(captionAt(captions, 5000)).toBeNull()
  })

  it('shows the translation in the chosen language, and the original where there is none', () => {
    const chinese = { ...captions, language: 'zh' as const }
    expect(captionAt(chinese, 500)).toBe('大家好。')
    expect(captionAt(chinese, 1500)).toBe('Vamos exportar.')
    expect(cueText(chinese, cues[0] ?? { id: '', startMs: 0, endMs: 1, text: '' })).toBe('大家好。')
  })

  it('shows nothing while captions are hidden', () => {
    expect(captionAt({ ...captions, visible: false }, 500)).toBeNull()
  })
})
