import { describe, expect, it } from 'vitest'
import type { InteractionEvent } from '@shared/models/telemetry'
import { CURSOR_DRAW, clickRipplesAt, drawnCursorAt, drawnCursorPath } from './cursorRender'

const sample = (timeMs: number, x: number, y: number) => ({ timeMs, x, y })

describe('drawnCursorPath', () => {
  const samples = [sample(0, 0, 0), sample(100, 1, 0), sample(200, 1, 1)]

  it('interpolates between the samples when not smoothed', () => {
    const path = drawnCursorPath(samples, 200, 'none')
    expect(path).toHaveLength(Math.floor(200 / CURSOR_DRAW.stepMs) + 1)
    expect(drawnCursorAt(path, 48)).toEqual({ x: 0.48, y: 0 })
    expect(drawnCursorAt(path, 160)).toEqual({ x: 1, y: 0.6 })
  })

  it('averages over the window when smoothed, lagging a little behind a jump', () => {
    const jump = [sample(0, 0, 0), sample(100, 0, 0), sample(101, 1, 0), sample(400, 1, 0)]
    const plain = drawnCursorAt(drawnCursorPath(jump, 400, 'none'), 160)
    const smoothed = drawnCursorAt(drawnCursorPath(jump, 400, 'strong'), 160)
    expect(plain?.x).toBeCloseTo(1, 1)
    expect(smoothed?.x).toBeGreaterThan(0.1)
    expect(smoothed?.x).toBeLessThan(0.9)
    expect(drawnCursorAt(drawnCursorPath(jump, 400, 'strong'), 400)?.x).toBeCloseTo(1, 1)
  })

  it('knows nothing before the first sample and hides a pointer outside the recording', () => {
    expect(drawnCursorPath([], 100, 'none')).toEqual([])
    const late = drawnCursorPath([sample(100, 0.5, 0.5), sample(200, 1.2, 0.5)], 200, 'none')
    expect(drawnCursorAt(late, 0)).toBeNull()
    expect(drawnCursorAt(late, 112)?.x).toBeCloseTo(0.584)
    expect(drawnCursorAt(late, 112)?.y).toBe(0.5)
    expect(drawnCursorAt(late, 200)).toBeNull()
  })
})

describe('clickRipplesAt', () => {
  const event = (timeMs: number, type: InteractionEvent['type']): InteractionEvent => ({ timeMs, type, x: 0.3, y: 0.4, button: 'left' })
  const interactions = [event(1000, 'mouseDown'), event(1010, 'click'), event(2000, 'doubleClick'), event(5000, 'rightClick')]

  it('rings the clicks of the last moments, each as far along as its age', () => {
    expect(clickRipplesAt(interactions, 1100)).toEqual([{ x: 0.3, y: 0.4, progress: 90 / CURSOR_DRAW.rippleMs }])
    expect(clickRipplesAt(interactions, 2100)).toEqual([{ x: 0.3, y: 0.4, progress: 100 / CURSOR_DRAW.rippleMs }])
    expect(clickRipplesAt(interactions, 900)).toEqual([])
    expect(clickRipplesAt(interactions, 1010 + CURSOR_DRAW.rippleMs)).toEqual([])
  })
})
