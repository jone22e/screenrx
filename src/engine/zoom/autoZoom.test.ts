import { describe, expect, it } from 'vitest'
import type { ZoomEffect } from '@shared/models/project'
import type { InteractionEvent, InteractionType } from '@shared/models/telemetry'
import { generateAutoZooms, regenerateAutoZooms } from './autoZoom'
import { AUTO_ZOOM_CONFIG } from './zoomConfig'

const click = (timeMs: number, x: number, y: number, type: InteractionType = 'click'): InteractionEvent => ({
  timeMs,
  type,
  x,
  y,
  button: 'left'
})

function ids(): () => string {
  let next = 1
  return () => `zoom-${next++}`
}

const { paddingBeforeMs, paddingAfterMs } = AUTO_ZOOM_CONFIG

describe('generateAutoZooms', () => {
  it('produces nothing without clicks', () => {
    expect(generateAutoZooms([], 60_000, ids())).toEqual([])
    expect(generateAutoZooms([click(1000, 0.5, 0.5, 'mouseDown')], 60_000, ids())).toEqual([])
  })

  it('merges nearby clicks into one zoom focused on their centre', () => {
    const zooms = generateAutoZooms([click(5000, 0.72, 0.4), click(6300, 0.74, 0.42)], 60_000, ids())
    expect(zooms).toHaveLength(1)
    expect(zooms[0]).toMatchObject({
      type: 'zoom',
      startMs: 5000 - paddingBeforeMs,
      endMs: 6300 + paddingAfterMs,
      scale: AUTO_ZOOM_CONFIG.scale,
      mode: 'auto'
    })
    expect(zooms[0]?.focus.x).toBeCloseTo(0.73)
    expect(zooms[0]?.focus.y).toBeCloseTo(0.41)
  })

  it('starts a new zoom after a long pause between clicks', () => {
    const gap = AUTO_ZOOM_CONFIG.clickClusterMergeGapMs
    const zooms = generateAutoZooms([click(2000, 0.5, 0.5), click(2000 + gap + 1500, 0.5, 0.5)], 60_000, ids())
    expect(zooms).toHaveLength(2)
    expect(zooms[0]?.endMs).toBeLessThanOrEqual(zooms[1]?.startMs ?? 0)
  })

  it('starts a new zoom for a click far away on screen, with the two back to back', () => {
    const zooms = generateAutoZooms([click(2000, 0.1, 0.1), click(2800, 0.9, 0.9)], 60_000, ids())
    expect(zooms).toHaveLength(2)
    expect(zooms[0]?.focus.x).toBeCloseTo(0.1)
    expect(zooms[1]?.focus.x).toBeCloseTo(0.9)
    // No overlap and no gap: the camera pans from one focus to the other.
    expect(zooms[0]?.endMs).toBe(zooms[1]?.startMs)
  })

  it('never leaves the recording', () => {
    const zooms = generateAutoZooms([click(100, 0.5, 0.5), click(9900, 0.5, 0.5)], 10_000, ids())
    expect(zooms[0]?.startMs).toBe(0)
    expect(zooms.at(-1)?.endMs).toBe(10_000)
  })

  it('ignores clicks outside the captured area and accepts them in any order', () => {
    const zooms = generateAutoZooms(
      [click(9000, 0.5, 0.5), click(3000, 1.4, 0.5), click(1000, 0.2, 0.2, 'doubleClick')],
      60_000,
      ids()
    )
    expect(zooms.map((zoom) => zoom.startMs)).toEqual([1000 - paddingBeforeMs, 9000 - paddingBeforeMs])
  })
})

describe('regenerateAutoZooms', () => {
  const manual: ZoomEffect = {
    id: 'mine',
    type: 'zoom',
    startMs: 4000,
    endMs: 7000,
    focus: { x: 0.3, y: 0.3 },
    scale: 2.5,
    easing: 'easeInOut',
    mode: 'manual'
  }
  const stale: ZoomEffect = { ...manual, id: 'stale', startMs: 20_000, endMs: 22_000, mode: 'auto' }

  it('keeps manual zooms, drops old automatic ones, and yields to the user on overlap', () => {
    const zooms = regenerateAutoZooms(
      [manual, stale],
      [click(5000, 0.8, 0.8), click(12_000, 0.6, 0.6)],
      60_000,
      ids()
    )
    expect(zooms.map((zoom) => zoom.id)).toEqual(['mine', 'zoom-2'])
    expect(zooms[1]?.startMs).toBe(12_000 - paddingBeforeMs)
  })
})
