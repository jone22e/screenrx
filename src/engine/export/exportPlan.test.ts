import { describe, expect, it } from 'vitest'
import { buildTimeMap } from '../time/timeMapping'
import { createExportPlan, estimatedFileBytes, frameSourceTimeMs } from './exportPlan'

const source = { width: 3600, height: 2338 }
const settings = { format: 'mp4', quality: 'standard', compression: 0, fps: 30, speed: 1 } as const

describe('createExportPlan', () => {
  it('scales the recording down to the quality limit with even dimensions', () => {
    const plan = createExportPlan(source, buildTimeMap(60_000, []), settings)
    expect(plan.width).toBe(1920)
    expect(plan.height % 2).toBe(0)
    expect(plan.width / plan.height).toBeCloseTo(3600 / 2338, 2)
    expect(plan.frameCount).toBe(1800)
  })

  it('shapes the file for a format, capping the longer side', () => {
    const map = buildTimeMap(10_000, [])
    const reels = createExportPlan({ width: 1920, height: 1080 }, map, { ...settings, quality: 'high' }, '9:16')
    expect([reels.width, reels.height]).toEqual([1080, 1920])
    const retina = createExportPlan({ width: 3456, height: 2234 }, map, { ...settings, quality: 'high' }, '9:16')
    expect(retina.height).toBe(2560)
    expect(retina.width % 2).toBe(0)
    expect(retina.width / retina.height).toBeCloseTo(9 / 16, 2)
  })

  it('squeezes harder at each compression level, switching to HEVC from the middle one', () => {
    const map = buildTimeMap(60_000, [])
    const fullHd = { width: 1920, height: 1080 }
    const plans = ([0, 1, 2, 3, 4] as const).map((compression) => createExportPlan(fullHd, map, { ...settings, compression }))
    expect(plans.map((plan) => plan.codec)).toEqual(['h264', 'h264', 'hevc', 'hevc', 'hevc'])
    for (let level = 1; level < plans.length; level++) {
      expect(plans[level]!.videoBitrate).toBeLessThan(plans[level - 1]!.videoBitrate)
      expect(plans[level]!.audioBitrate).toBeLessThanOrEqual(plans[level - 1]!.audioBitrate)
      expect([plans[level]!.width, plans[level]!.height]).toEqual([plans[0]!.width, plans[0]!.height])
    }
    expect(plans[4]!.videoBitrate / plans[0]!.videoBitrate).toBeCloseTo(0.3, 2)
  })

  it('estimates the file from the bitrates and the duration', () => {
    const plan = createExportPlan({ width: 1920, height: 1080 }, buildTimeMap(60_000, []), settings)
    const bytes = estimatedFileBytes(plan, true)
    expect(bytes).toBeCloseTo(((plan.videoBitrate + plan.audioBitrate) / 8) * 60 * 1.02, -3)
    expect(estimatedFileBytes(plan, false)).toBeLessThan(bytes)
  })

  it('never upscales', () => {
    const plan = createExportPlan({ width: 1280, height: 720 }, buildTimeMap(10_000, []), {
      ...settings,
      quality: 'high'
    })
    expect([plan.width, plan.height]).toEqual([1280, 720])
  })

  it.each([
    [24, 1440],
    [30, 1800],
    [60, 3600]
  ] as const)('renders %d frames per second: %d frames for a minute', (fps, frameCount) => {
    const plan = createExportPlan(source, buildTimeMap(60_000, []), { ...settings, fps })
    expect(plan.fps).toBe(fps)
    expect(plan.frameCount).toBe(frameCount)
    expect(plan.outputDurationMs).toBe(60_000)
  })

  it('gives more frames per second more bits, within the limits', () => {
    const map = buildTimeMap(60_000, [])
    // Large enough to be above the minimum bitrate at every rate.
    const fullHd = { width: 1920, height: 1080 }
    const at = (fps: 24 | 30 | 60): number => createExportPlan(fullHd, map, { ...settings, fps }).videoBitrate
    expect(at(24)).toBeLessThan(at(30))
    expect(at(60)).toBeCloseTo(at(30) * 2, -3)
    expect(createExportPlan(source, map, { ...settings, quality: 'high', fps: 60 }).videoBitrate).toBeLessThanOrEqual(40_000_000)
  })

  it('shows the same instant of the recording at the same output time, whatever the frame rate', () => {
    const map = buildTimeMap(60_000, [])
    const slow = createExportPlan(source, map, { ...settings, fps: 24 })
    const smooth = createExportPlan(source, map, { ...settings, fps: 60 })
    expect(frameSourceTimeMs(slow, map, 24 * 5)).toBeCloseTo(5000)
    expect(frameSourceTimeMs(smooth, map, 60 * 5)).toBeCloseTo(5000)
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
