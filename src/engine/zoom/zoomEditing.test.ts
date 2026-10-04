import { describe, expect, it } from 'vitest'
import type { ZoomEffect } from '@shared/models/project'
import { MANUAL_ZOOM_DEFAULTS, ZOOM_LIMITS } from './zoomConfig'
import { clampScale, moveZoom, resizeZoom, spanForNewZoom } from './zoomEditing'

const zoom = (id: string, startMs: number, endMs: number): ZoomEffect => ({
  id,
  type: 'zoom',
  startMs,
  endMs,
  focus: { x: 0.5, y: 0.5 },
  scale: 2,
  easing: 'easeInOut',
  mode: 'manual'
})

const a = zoom('a', 1000, 3000)
const b = zoom('b', 5000, 8000)
const c = zoom('c', 9000, 10_000)
const zooms = [a, b, c]
const duration = 20_000

describe('moveZoom', () => {
  it('slides a zoom keeping its length', () => {
    expect(moveZoom(zooms, b, 500, duration)).toEqual({ startMs: 5500, endMs: 8500 })
  })

  it('stops at its neighbours and at the ends of the recording', () => {
    expect(moveZoom(zooms, b, 5000, duration)).toEqual({ startMs: 6000, endMs: 9000 })
    expect(moveZoom(zooms, b, -5000, duration)).toEqual({ startMs: 3000, endMs: 6000 })
    expect(moveZoom(zooms, a, -5000, duration)).toEqual({ startMs: 0, endMs: 2000 })
    expect(moveZoom(zooms, c, 50_000, duration)).toEqual({ startMs: 19_000, endMs: 20_000 })
  })
})

describe('resizeZoom', () => {
  it('moves one edge and leaves the other alone', () => {
    expect(resizeZoom(zooms, b, 'start', 4200, duration)).toEqual({ startMs: 4200, endMs: 8000 })
    expect(resizeZoom(zooms, b, 'end', 8600, duration)).toEqual({ startMs: 5000, endMs: 8600 })
  })

  it('cannot cross a neighbour or collapse below the minimum duration', () => {
    expect(resizeZoom(zooms, b, 'start', 0, duration).startMs).toBe(3000)
    expect(resizeZoom(zooms, b, 'end', 50_000, duration).endMs).toBe(9000)
    expect(resizeZoom(zooms, b, 'start', 7990, duration).startMs).toBe(8000 - ZOOM_LIMITS.minDurationMs)
    expect(resizeZoom(zooms, b, 'end', 5001, duration).endMs).toBe(5000 + ZOOM_LIMITS.minDurationMs)
  })
})

describe('spanForNewZoom', () => {
  it('uses the default length in open space', () => {
    expect(spanForNewZoom(zooms, 12_000, duration)).toEqual({
      startMs: 12_000,
      endMs: 12_000 + MANUAL_ZOOM_DEFAULTS.durationMs
    })
  })

  it('shrinks to fit before the next zoom', () => {
    expect(spanForNewZoom(zooms, 3500, duration)).toEqual({ startMs: 3500, endMs: 5000 })
  })

  it('backs up to fit a gap that is just large enough', () => {
    expect(spanForNewZoom(zooms, 8700, duration)).toEqual({ startMs: 8400, endMs: 9000 })
  })

  it('refuses a spot inside a zoom or in a gap too small for one', () => {
    expect(spanForNewZoom(zooms, 6000, duration)).toBeNull()
    const tight = [zoom('x', 0, 1000), zoom('y', 1400, 3000)]
    expect(spanForNewZoom(tight, 1200, duration)).toBeNull()
  })

  it('backs up from the very end of the recording', () => {
    expect(spanForNewZoom(zooms, 19_900, duration)).toEqual({
      startMs: duration - ZOOM_LIMITS.minDurationMs,
      endMs: duration
    })
  })
})

describe('clampScale', () => {
  it('stays within the supported range', () => {
    expect(clampScale(0.5)).toBe(ZOOM_LIMITS.minScale)
    expect(clampScale(99)).toBe(ZOOM_LIMITS.maxScale)
    expect(clampScale(2)).toBe(2)
  })
})
