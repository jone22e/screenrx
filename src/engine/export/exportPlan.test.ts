import { describe, expect, it } from 'vitest'
import { buildTimeMap } from '../time/timeMapping'
import { createExportPlan, frameSourceTimeMs } from './exportPlan'

const source = { width: 3600, height: 2338 }
const settings = { format: 'mp4', quality: 'standard', speed: 1 } as const

describe('createExportPlan', () => {
  it('scales the recording down to the quality limit with even dimensions', () => {
    const plan = createExportPlan(source, buildTimeMap(60_000, []), settings)
    expect(plan.width).toBe(1920)
    expect(plan.height % 2).toBe(0)
    expect(plan.width / plan.height).toBeCloseTo(3600 / 2338, 2)
    expect(plan.frameCount).toBe(1800)
  })

  it('never upscales', () => {
    const plan = createExportPlan({ width: 1280, height: 720 }, buildTimeMap(10_000, []), {
      ...settings,
      quality: 'high'
    })
    expect([plan.width, plan.height]).toEqual([1280, 720])
  })

  it('halves the duration and the frame count at 2x', () => {
    const map = buildTimeMap(60_000, [])
    const normal = createExportPlan(source, map, settings)
    const fast = createExportPlan(source, map, { ...settings, speed: 2 })
    expect(normal.outputDurationMs).toBe(60_000)
    expect(fast.outputDurationMs).toBe(30_000)
    expect(fast.frameCount).toBe(normal.frameCount / 2)
  })
})

describe('frameSourceTimeMs', () => {
  it('walks the recording faster at 2x: output 1 s shows source 2 s', () => {
    const map = buildTimeMap(60_000, [])
    const plan = createExportPlan(source, map, { ...settings, speed: 2 })
    expect(frameSourceTimeMs(plan, map, 0)).toBe(0)
    expect(frameSourceTimeMs(plan, map, plan.fps)).toBeCloseTo(2000)
    expect(frameSourceTimeMs(plan, map, plan.fps * 10)).toBeCloseTo(20_000)
  })

  it('skips cut spans', () => {
    const map = buildTimeMap(60_000, [{ id: 'cut', type: 'trim', startMs: 0, endMs: 30_000 }])
    const plan = createExportPlan(source, map, settings)
    expect(frameSourceTimeMs(plan, map, 0)).toBe(30_000)
    expect(frameSourceTimeMs(plan, map, plan.fps)).toBeCloseTo(31_000)
    expect(plan.frameCount).toBe(900)
  })
})
