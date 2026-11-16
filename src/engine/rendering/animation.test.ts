import { describe, expect, it } from 'vitest'
import { STILL_TRANSFORM, TEXT_MOTION, textTransformAt } from './animation'

const motion = (kind: 'none' | 'fade' | 'pop' | 'slide-up', durationMs = 400) => ({ kind, durationMs })

describe('textTransformAt', () => {
  it('is still without motions, and between an entrance and an exit', () => {
    expect(textTransformAt(motion('none'), motion('none'), 10, 5000)).toEqual(STILL_TRANSFORM)
    expect(textTransformAt(motion('fade'), motion('fade'), 1000, 1000)).toEqual(STILL_TRANSFORM)
  })

  it('fades in over the entrance and out over the exit', () => {
    expect(textTransformAt(motion('fade'), motion('none'), 0, 5000).alpha).toBe(0)
    expect(textTransformAt(motion('fade'), motion('none'), 200, 5000).alpha).toBeCloseTo(0.5)
    expect(textTransformAt(motion('fade'), motion('none'), 400, 5000).alpha).toBe(1)
    expect(textTransformAt(motion('none'), motion('fade'), 5000, 100).alpha).toBeCloseTo(textTransformAt(motion('fade'), motion('none'), 100, 5000).alpha)
    expect(textTransformAt(motion('none'), motion('fade'), 5000, 0).alpha).toBe(0)
  })

  it('pops past its size and settles', () => {
    expect(textTransformAt(motion('pop'), motion('none'), 200, 5000).scale).toBeCloseTo(TEXT_MOTION.popOvershoot)
    expect(textTransformAt(motion('pop'), motion('none'), 400, 5000).scale).toBe(1)
    expect(textTransformAt(motion('pop'), motion('none'), 0, 5000).scale).toBeLessThan(1)
  })

  it('slides up on the way in and keeps going up on the way out', () => {
    const entering = textTransformAt(motion('slide-up'), motion('none'), 100, 5000)
    expect(entering.offsetY).toBeGreaterThan(0)
    expect(entering.offsetY).toBeLessThanOrEqual(TEXT_MOTION.slideRatio)
    const leaving = textTransformAt(motion('none'), motion('slide-up'), 5000, 100)
    expect(leaving.offsetY).toBeLessThan(0)
    expect(leaving.alpha).toBeCloseTo(entering.alpha)
  })
})
