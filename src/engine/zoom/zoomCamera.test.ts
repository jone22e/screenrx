import { describe, expect, it } from 'vitest'
import type { ZoomEffect } from '@shared/models/project'
import { IDENTITY_CAMERA, cameraAt, easeInOut, viewToSource, visibleRect } from './zoomCamera'
import { ZOOM_ANIMATION } from './zoomConfig'

function zoom(startMs: number, endMs: number, x: number, y: number, scale = 2): ZoomEffect {
  return {
    id: `zoom-${startMs}`,
    type: 'zoom',
    startMs,
    endMs,
    focus: { x, y },
    scale,
    easing: 'easeInOut',
    mode: 'manual'
  }
}

describe('easeInOut', () => {
  it('starts and ends at rest', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(-1)).toBe(0)
    expect(easeInOut(2)).toBe(1)
  })
})

describe('cameraAt', () => {
  const zooms = [zoom(5000, 8000, 0.5, 0.5)]

  it('shows the whole frame outside any zoom', () => {
    expect(cameraAt(zooms, 0)).toEqual(IDENTITY_CAMERA)
    expect(cameraAt(zooms, 4999)).toEqual(IDENTITY_CAMERA)
    expect(cameraAt(zooms, 8000)).toEqual(IDENTITY_CAMERA)
    expect(cameraAt([], 1234)).toEqual(IDENTITY_CAMERA)
  })

  it('is fully zoomed once the transition has finished', () => {
    const camera = cameraAt(zooms, 5000 + ZOOM_ANIMATION.zoomInDurationMs)
    expect(camera.scale).toBeCloseTo(2)
    expect(cameraAt(zooms, 6500).scale).toBeCloseTo(2)
  })

  it('eases in and out without jumps', () => {
    const scales: number[] = []
    for (let time = 4990; time <= 8010; time += 10) scales.push(cameraAt(zooms, time).scale)

    expect(scales[0]).toBe(1)
    expect(scales.at(-1)).toBe(1)
    expect(Math.max(...scales)).toBeCloseTo(2)
    const largestStep = Math.max(...scales.slice(1).map((scale, i) => Math.abs(scale - (scales[i] ?? 1))))
    // The cubic ease peaks at three times the average speed: 3 × 10 ms / 450 ms.
    expect(largestStep).toBeLessThan(0.07)

    // Monotonic rise, then monotonic fall.
    const peak = scales.indexOf(Math.max(...scales))
    for (let i = 1; i <= peak; i++) expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1] ?? 0)
  })

  it('keeps the view inside the frame when the focus is near an edge', () => {
    const corner = [zoom(0, 4000, 0.98, 0.02)]
    const rect = visibleRect(cameraAt(corner, 2000))
    expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9)
    expect(rect.y).toBeGreaterThanOrEqual(-1e-9)
    expect(rect.width).toBeCloseTo(0.5)
  })

  it('pans between back-to-back zooms instead of zooming out', () => {
    const pair = [zoom(0, 3000, 0.25, 0.5), zoom(3000, 6000, 0.75, 0.5)]
    // Around the boundary the camera stays zoomed in…
    for (const time of [2600, 2990, 3000, 3100, 3400]) {
      expect(cameraAt(pair, time).scale).toBeCloseTo(2)
    }
    // …while its centre travels from the first focus to the second.
    expect(cameraAt(pair, 2990).centerX).toBeCloseTo(0.25)
    expect(cameraAt(pair, 3000 + ZOOM_ANIMATION.zoomInDurationMs).centerX).toBeCloseTo(0.75)
    const midway = cameraAt(pair, 3000 + ZOOM_ANIMATION.zoomInDurationMs / 2).centerX
    expect(midway).toBeGreaterThan(0.25)
    expect(midway).toBeLessThan(0.75)
  })

  it('still returns to the whole frame when zooms are apart', () => {
    const pair = [zoom(0, 3000, 0.25, 0.5), zoom(3500, 6000, 0.75, 0.5)]
    expect(cameraAt(pair, 3200)).toEqual(IDENTITY_CAMERA)
    expect(cameraAt(pair, 2999).scale).toBeLessThan(1.01)
  })

  it('fits both transitions into a zoom shorter than they are', () => {
    const brief = [zoom(1000, 1400, 0.5, 0.5)]
    expect(cameraAt(brief, 1000).scale).toBe(1)
    expect(cameraAt(brief, 1200).scale).toBeCloseTo(2)
    expect(cameraAt(brief, 1399).scale).toBeLessThan(1.05)
  })
})

describe('viewToSource', () => {
  it('maps the middle of the view to the camera centre', () => {
    const camera = { scale: 2, centerX: 0.7, centerY: 0.4 }
    expect(viewToSource(camera, 0.5, 0.5)).toEqual({ x: 0.7, y: 0.4 })
    expect(viewToSource(camera, 0, 0).x).toBeCloseTo(0.45)
    expect(viewToSource(IDENTITY_CAMERA, 0.2, 0.9)).toEqual({ x: 0.2, y: 0.9 })
  })
})
