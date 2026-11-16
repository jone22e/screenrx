import { describe, expect, it } from 'vitest'
import type { TranscriptWord } from '@shared/models/captions'
import type { CaptionCue } from '@shared/models/project'
import { createCaptionSettings, spreadWords } from '@shared/models/project'
import {
  activeWordIndex,
  buildCues,
  captionAt,
  clipCue,
  cueAt,
  cueText,
  fitCue,
  normalizeWords,
  rewordCue
} from './captionCues'

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
      { id: 'cue-0', startMs: 0, endMs: 2200, text: 'e agora', words: [word('e', 0, 200), word('agora', 200, 2200)] },
      { id: 'cue-1', startMs: 6000, endMs: 6500, text: 'continua', words: [word('continua', 6000, 6500)] }
    ])
  })

  it('keeps each word with its own time', () => {
    const cues = buildCues(speech('um dois tres'), 'medium', ids())
    expect(cues[0]?.words).toEqual([word('um', 0, 300), word('dois', 300, 600), word('tres', 600, 900)])
  })

  it('makes one caption per word, and up to three per pair', () => {
    expect(buildCues(speech('um dois tres quatro'), 'word', ids()).map((cue) => cue.text)).toEqual(['um', 'dois', 'tres', 'quatro'])
    expect(buildCues(speech('um dois tres quatro cinco'), 'pair', ids()).map((cue) => cue.text)).toEqual(['um dois tres', 'quatro cinco'])
  })

  it('holds a caption until the next one when the gap between them is short', () => {
    // 250 ms between "oi" and "tchau": the first stays on so the text does not blink.
    const close = buildCues([word('oi', 0, 300), word('tchau', 550, 900)], 'word', ids())
    expect(close.map((cue) => [cue.startMs, cue.endMs])).toEqual([[0, 550], [550, 900]])
    // 800 ms: a real blank.
    const apart = buildCues([word('oi', 0, 300), word('tchau', 1100, 1400)], 'word', ids())
    expect(apart.map((cue) => [cue.startMs, cue.endMs])).toEqual([[0, 300], [1100, 1400]])
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

const cue = (id: string, startMs: number, endMs: number, text: string): CaptionCue => ({
  id,
  startMs,
  endMs,
  text,
  words: spreadWords(text, startMs, endMs)
})

describe('rewordCue', () => {
  const original = cue('a', 0, 1000, 'olá pessoal, tudo')

  it('keeps the timing of a corrected word', () => {
    const corrected = rewordCue(original, 'olá pessoal. tudo')
    expect(corrected.text).toBe('olá pessoal. tudo')
    expect(corrected.words.map((word) => word.text)).toEqual(['olá', 'pessoal.', 'tudo'])
    expect(corrected.words.map((word) => word.startMs)).toEqual(original.words.map((word) => word.startMs))
  })

  it('spreads the words anew when their number changes', () => {
    const rewritten = rewordCue(original, 'oi  gente')
    expect(rewritten.words).toEqual([word('oi', 0, 500), word('gente', 500, 1000)])
  })
})

describe('fitCue and clipCue', () => {
  it('carries the words along when the caption is moved or stretched', () => {
    const moved = fitCue(cue('a', 0, 1000, 'um dois'), { startMs: 500, endMs: 1500 })
    expect(moved.words).toEqual([word('um', 500, 1000), word('dois', 1000, 1500)])
    const stretched = fitCue(cue('a', 0, 1000, 'um dois'), { startMs: 0, endMs: 2000 })
    expect(stretched.words).toEqual([word('um', 0, 1000), word('dois', 1000, 2000)])
  })

  it('clips the words with the caption', () => {
    const clipped = clipCue(cue('a', 0, 1000, 'um dois'), 700)
    expect(clipped.endMs).toBe(700)
    expect(clipped.words).toEqual([word('um', 0, 500), word('dois', 500, 700)])
    expect(clipCue(cue('a', 0, 1000, 'um'), 1000).endMs).toBe(1000)
  })
})

describe('activeWordIndex', () => {
  const words = [word('um', 100, 300), word('dois', 400, 600), word('tres', 700, 900)]

  it('is the last word begun, held through the silence after it', () => {
    expect(activeWordIndex(words, 0)).toBe(0)
    expect(activeWordIndex(words, 350)).toBe(0)
    expect(activeWordIndex(words, 400)).toBe(1)
    expect(activeWordIndex(words, 5000)).toBe(2)
    expect(activeWordIndex([], 100)).toBeNull()
  })
})

describe('cueAt', () => {
  const cues = [cue('a', 0, 1000, 'a'), cue('b', 1000, 2000, 'b'), cue('c', 5000, 6000, 'c')]

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
  const cues = [cue('a', 0, 1000, 'Olá, pessoal.'), cue('b', 1000, 2000, 'Vamos exportar.')]
  const captions = { ...createCaptionSettings(), cues, translations: { zh: { a: '大家好。' } } }

  it('shows what was spoken when no language is chosen', () => {
    expect(captionAt(captions, 500)?.text).toBe('Olá, pessoal.')
    expect(captionAt(captions, 5000)).toBeNull()
  })

  it('tells which word is being spoken and for how long', () => {
    expect(captionAt(captions, 200)).toEqual({ text: 'Olá, pessoal.', activeWord: 0, sinceStartMs: 200, sinceWordMs: 200 })
    expect(captionAt(captions, 800)).toEqual({ text: 'Olá, pessoal.', activeWord: 1, sinceStartMs: 800, sinceWordMs: 300 })
  })

  it('shows the translation in the chosen language, and the original where there is none', () => {
    const chinese = { ...captions, language: 'zh' as const }
    // A translation has no timing of its own: no word is singled out.
    expect(captionAt(chinese, 500)).toEqual({ text: '大家好。', activeWord: null, sinceStartMs: 500, sinceWordMs: 500 })
    expect(captionAt(chinese, 1500)?.text).toBe('Vamos exportar.')
    expect(cueText(chinese, cues[0] ?? cue('', 0, 1, ''))).toBe('大家好。')
  })

  it('shows nothing while captions are hidden', () => {
    expect(captionAt({ ...captions, visible: false }, 500)).toBeNull()
  })
})
