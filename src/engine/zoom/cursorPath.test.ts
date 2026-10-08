import { describe, expect, it } from 'vitest'
import { CURSOR_FOLLOW, pointerAt, smoothCursorPath } from './cursorPath'

describe('smoothCursorPath', () => {
  it('averages the pointer over the window, so a jump becomes a glide', () => {
    const samples = [
      { timeMs: 0, x: 0.2, y: 0.5 },
      { timeMs: 1000, x: 0.8, y: 0.5 }
    ]
    const path = smoothCursorPath(samples, 2000)
    expect(path).toHaveLength(2000 / CURSOR_FOLLOW.stepMs + 1)
    expect(pointerAt(path, 500).x).toBeCloseTo(0.2)
    expect(pointerAt(path, 500).y).toBeCloseTo(0.5)
    // Just after the jump, most of the window still sees the old place.
    expect(pointerAt(path, 1000).x).toBeGreaterThan(0.2)
    expect(pointerAt(path, 1000).x).toBeLessThan(0.5)
    expect(pointerAt(path, 1000 + CURSOR_FOLLOW.windowMs).x).toBeCloseTo(0.8)
  })

  it('keeps the pointer inside the recording and holds the last place when it leaves', () => {
    const path = smoothCursorPath([{ timeMs: 0, x: -0.9, y: 1.4 }], 200)
    expect(pointerAt(path, 100)).toEqual({ x: 0, y: 1 })
  })

  it('stays where the path starts before its first sample', () => {
    const path = smoothCursorPath([{ timeMs: 2000, x: 0.7, y: 0.3 }], 3000)
    expect(pointerAt(path, 0)).toEqual({ x: 0.7, y: 0.3 })
  })

  it('points at the centre without telemetry', () => {
    expect(smoothCursorPath([], 1000)).toEqual([])
    expect(pointerAt([], 500)).toEqual({ x: 0.5, y: 0.5 })
  })
})
