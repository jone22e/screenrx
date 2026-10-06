import { describe, expect, it } from 'vitest'
import { DUB_CONFIG } from './dubConfig'
import { buildDubUnits, layoutDubClips, pickVoiceReference } from './dubUnits'

const cue = (startMs: number, endMs: number, text: string) => ({ startMs, endMs, text })

describe('buildDubUnits', () => {
  it('joins the captions of a sentence into one stretch of speech', () => {
    const units = buildDubUnits(
      [cue(0, 1000, 'Hello everyone,'), cue(1000, 2200, 'today we export'), cue(2200, 3000, 'a video.'), cue(3000, 4000, 'First, click.')],
      10_000
    )
    expect(units).toEqual([
      { id: 'unit-1', startMs: 0, slotEndMs: 3000, text: 'Hello everyone, today we export a video.' },
      { id: 'unit-2', startMs: 3000, slotEndMs: 10_000, text: 'First, click.' }
    ])
  })

  it('starts a new stretch after a pause, even mid-sentence', () => {
    const units = buildDubUnits([cue(0, 1000, 'and now'), cue(1000 + DUB_CONFIG.pauseBetweenUnitsMs + 1, 3000, 'we continue')], 5000)
    expect(units.map((unit) => unit.text)).toEqual(['and now', 'we continue'])
    expect(units[0]?.slotEndMs).toBe(units[1]?.startMs)
  })

  it('splits a stretch that would be spoken for too long', () => {
    const cues = Array.from({ length: 10 }, (_, index) => cue(index * 2000, (index + 1) * 2000, `part ${index}`))
    const units = buildDubUnits(cues, 20_000)
    expect(units.length).toBeGreaterThan(1)
    for (const unit of units) expect(unit.slotEndMs - unit.startMs).toBeLessThanOrEqual(DUB_CONFIG.maxUnitMs)
    expect(units.map((unit) => unit.text).join(' ')).toBe(cues.map((entry) => entry.text).join(' '))
  })

  it('joins Chinese without spaces and ends stretches at its own punctuation', () => {
    const units = buildDubUnits([cue(0, 1000, '大家好，今天'), cue(1000, 2000, '我们来导出视频。'), cue(2000, 3000, '首先')], 5000)
    expect(units.map((unit) => unit.text)).toEqual(['大家好，今天我们来导出视频。', '首先'])
  })

  it('skips empty captions and returns nothing for none', () => {
    expect(buildDubUnits([cue(0, 1000, '  '), cue(1000, 2000, 'Hi.')], 3000).map((unit) => unit.text)).toEqual(['Hi.'])
    expect(buildDubUnits([], 3000)).toEqual([])
  })
})

describe('pickVoiceReference', () => {
  /** Words of 500 ms each, starting at `startMs`. */
  const speech = (text: string, startMs = 0) =>
    text.split(' ').map((part, index) => ({ text: part, startMs: startMs + index * 500, endMs: startMs + (index + 1) * 500 }))

  it('takes the first seconds of speech, up to the limit, and ends the text with a full stop', () => {
    const reference = pickVoiceReference(speech(Array.from({ length: 40 }, (_, index) => `w${index}`).join(' '), 1000))
    expect(reference?.startMs).toBe(1000)
    expect(reference && reference.endMs - reference.startMs).toBe(DUB_CONFIG.reference.maxMs)
    expect(reference?.text.split(' ')).toHaveLength(13)
    expect(reference?.text.endsWith('w12.')).toBe(true)
  })

  it('prefers to stop at the end of a sentence once there is enough speech', () => {
    // The sentence ends at 4 s; the limit would allow 6.5 s.
    const reference = pickVoiceReference(speech('a b c d e f g fim. i j k l m n o p'))
    expect(reference?.endMs).toBe(4000)
    expect(reference?.text).toBe('a b c d e f g fim.')
  })

  it('stops at a pause, keeping only the spoken part of the word before it', () => {
    // "pausa" is stretched by the recognizer over 2 s of silence.
    const words = [
      ...speech('um dois tres quatro cinco seis sete'),
      { text: 'pausa,', startMs: 3500, endMs: 5500 },
      ...speech('depois continua a frase', 5500)
    ]
    const reference = pickVoiceReference(words)
    expect(reference?.endMs).toBe(3500 + DUB_CONFIG.referencePauseWordMs)
    expect(reference?.text).toBe('um dois tres quatro cinco seis sete pausa.')
  })

  it('is null when there is too little speech to learn a voice from', () => {
    expect(pickVoiceReference(speech('só três palavras'))).toBeNull()
    expect(pickVoiceReference([])).toBeNull()
  })
})

describe('layoutDubClips', () => {
  const units = [
    { id: 'a', startMs: 0, slotEndMs: 3000, text: 'a' },
    { id: 'b', startMs: 3000, slotEndMs: 6000, text: 'b' },
    { id: 'c', startMs: 6000, slotEndMs: 9000, text: 'c' }
  ]

  it('starts each stretch when its caption does', () => {
    const placed = layoutDubClips(units, new Map([['a', 2500], ['b', 2000], ['c', 1000]]), 10_000)
    expect(placed.map((clip) => clip.startMs)).toEqual([0, 3000, 6000])
  })

  it('makes a stretch wait for the one before it instead of talking over it', () => {
    const placed = layoutDubClips(units, new Map([['a', 3400], ['b', 2000], ['c', 1000]]), 10_000)
    expect(placed[1]?.startMs).toBe(3400 + DUB_CONFIG.gapAfterOverrunMs)
    // The delay is absorbed by the pause that follows: the third is on time again.
    expect(placed[2]?.startMs).toBe(6000)
  })

  it('leaves out stretches with no audio and anything past the end', () => {
    expect(layoutDubClips(units, new Map([['a', 1000], ['c', 1000]]), 10_000).map((clip) => clip.id)).toEqual(['a', 'c'])
    expect(layoutDubClips(units, new Map([['a', 1000], ['b', 1000], ['c', 1000]]), 5000).map((clip) => clip.id)).toEqual(['a', 'b'])
  })
})
