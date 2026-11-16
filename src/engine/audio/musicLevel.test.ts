import { describe, expect, it } from 'vitest'
import { DEFAULT_MUSIC } from '@shared/models/project'
import { MUSIC_PREVIEW, approachGain, isSpeakingAt, musicTargetGain, speechSpans } from './musicLevel'

const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })

describe('speechSpans', () => {
  it('joins words that follow each other closely and keeps real pauses apart', () => {
    const words = [word('oi', 0, 300), word('gente', 400, 800), word('tchau', 3000, 3400), word('fora', 2000, 2200)]
    expect(speechSpans(words)).toEqual([
      { startMs: 0, endMs: 800 },
      { startMs: 2000, endMs: 2200 },
      { startMs: 3000, endMs: 3400 }
    ])
  })

  it('finds whether someone speaks at an instant', () => {
    const spans = speechSpans([word('a', 100, 300), word('b', 1000, 1200)])
    expect(isSpeakingAt(spans, 0)).toBe(false)
    expect(isSpeakingAt(spans, 200)).toBe(true)
    expect(isSpeakingAt(spans, 300)).toBe(false)
    expect(isSpeakingAt(spans, 1100)).toBe(true)
    expect(isSpeakingAt([], 100)).toBe(false)
  })
})

describe('musicTargetGain', () => {
  const music = { ...DEFAULT_MUSIC, volume: 0.5, fadeInMs: 1000, fadeOutMs: 2000, ducking: 'strong' as const }

  it('fades in, holds, and fades out', () => {
    expect(musicTargetGain(music, 0, 10_000, false)).toBe(0)
    expect(musicTargetGain(music, 500, 10_000, false)).toBeCloseTo(0.25)
    expect(musicTargetGain(music, 5000, 10_000, false)).toBe(0.5)
    expect(musicTargetGain(music, 9000, 10_000, false)).toBeCloseTo(0.25)
    expect(musicTargetGain(music, 10_000, 10_000, false)).toBe(0)
  })

  it('presses the music down while someone speaks, as the ducking asks', () => {
    expect(musicTargetGain(music, 5000, 10_000, true)).toBeCloseTo(0.5 * MUSIC_PREVIEW.duckGain.strong)
    expect(musicTargetGain({ ...music, ducking: 'off' }, 5000, 10_000, true)).toBe(0.5)
  })

  it('needs no fade when none is set', () => {
    expect(musicTargetGain({ ...music, fadeInMs: 0, fadeOutMs: 0 }, 0, 10_000, false)).toBe(0.5)
  })
})

describe('approachGain', () => {
  it('goes down fast and comes back slowly', () => {
    const down = approachGain(1, 0, MUSIC_PREVIEW.attackMs)
    const up = approachGain(0, 1, MUSIC_PREVIEW.attackMs)
    expect(down).toBeCloseTo(1 - (1 - Math.exp(-1)))
    expect(up).toBeLessThan(1 - down)
    expect(approachGain(0.3, 0.3, 100)).toBe(0.3)
    expect(approachGain(0.3, 0.9, 0)).toBe(0.3)
  })
})
