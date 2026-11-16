import { describe, expect, it } from 'vitest'
import type { TrimEffect } from '@shared/models/project'
import { TRANSITION_CONFIG, dipDarknessAt } from './transitions'

const trim = (startMs: number, endMs: number, transition: 'cut' | 'dip'): TrimEffect => ({ id: `${startMs}`, type: 'trim', startMs, endMs, transition })

describe('dipDarknessAt', () => {
  const half = TRANSITION_CONFIG.dipMs / 2
  const trims = [trim(1000, 2000, 'dip'), trim(5000, 6000, 'cut')]

  it('goes dark into the cut and comes back out of it', () => {
    expect(dipDarknessAt(trims, 1000 - half - 1)).toBe(0)
    expect(dipDarknessAt(trims, 1000 - half / 2)).toBeCloseTo(0.5)
    expect(dipDarknessAt(trims, 999)).toBeCloseTo(1 - 1 / half)
    expect(dipDarknessAt(trims, 1500)).toBe(1)
    expect(dipDarknessAt(trims, 2000)).toBe(1)
    expect(dipDarknessAt(trims, 2000 + half / 2)).toBeCloseTo(0.5)
    expect(dipDarknessAt(trims, 2000 + half)).toBe(0)
  })

  it('leaves a plain cut alone', () => {
    expect(dipDarknessAt(trims, 4900)).toBe(0)
    expect(dipDarknessAt(trims, 6050)).toBe(0)
    expect(dipDarknessAt([], 100)).toBe(0)
  })
})
