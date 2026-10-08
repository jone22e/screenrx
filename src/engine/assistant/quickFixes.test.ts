import { describe, expect, it } from 'vitest'
import { longPauses, totalMs } from './quickFixes'

const words = [
  { text: 'oi', startMs: 0, endMs: 400 },
  { text: 'tudo', startMs: 500, endMs: 900 },
  // a 3 s silence
  { text: 'bem', startMs: 3900, endMs: 4200 },
  // a 1.6 s silence, just long enough
  { text: 'então', startMs: 5800, endMs: 6100 },
  // too short to matter
  { text: 'vamos', startMs: 7000, endMs: 7300 }
]

describe('longPauses', () => {
  it('finds the silences worth cutting, with a margin on each side', () => {
    expect(longPauses(words, [])).toEqual([
      { startMs: 1100, endMs: 3700 },
      { startMs: 4400, endMs: 5600 }
    ])
    expect(totalMs(longPauses(words, []))).toBe(3800)
  })

  it('leaves out a pause a cut already covers', () => {
    expect(longPauses(words, [{ startMs: 1000, endMs: 3800 }])).toEqual([{ startMs: 4400, endMs: 5600 }])
  })

  it('finds nothing without two words', () => {
    expect(longPauses([], [])).toEqual([])
    expect(longPauses([words[0]!], [])).toEqual([])
  })
})
