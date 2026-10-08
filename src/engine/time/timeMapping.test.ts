import { describe, expect, it } from 'vitest'
import type { TimelineEffect } from '@shared/models/project'
import {
  buildTimeMap,
  isSourceTimeKept,
  keptSourceTime,
  nextKeptSourceTime,
  outputDurationMs,
  outputTimeToSourceTime,
  outputTimeToTimelineTime,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime
} from './timeMapping'

const trim = (startMs: number, endMs: number): TimelineEffect => ({ id: `t${startMs}`, type: 'trim', startMs, endMs })
const speed = (startMs: number, endMs: number, factor: number): TimelineEffect => ({
  id: `s${startMs}`,
  type: 'speed',
  startMs,
  endMs,
  speed: factor
})

describe('buildTimeMap', () => {
  it('is the identity without cuts or speed regions', () => {
    const map = buildTimeMap(60_000, [])
    expect(map.segments).toHaveLength(1)
    expect(map.timelineDurationMs).toBe(60_000)
    expect(sourceTimeToTimelineTime(map, 12_345)).toBe(12_345)
    expect(timelineTimeToSourceTime(map, 12_345)).toBe(12_345)
  })

  it('removes cuts from the timeline', () => {
    const map = buildTimeMap(60_000, [trim(10_000, 20_000), trim(50_000, 60_000)])
    expect(map.timelineDurationMs).toBe(40_000)
    expect(map.segments.map((s) => [s.sourceStartMs, s.sourceEndMs])).toEqual([
      [0, 10_000],
      [20_000, 50_000]
    ])
    // Before the cut nothing changes; after it everything moves earlier.
    expect(sourceTimeToTimelineTime(map, 5_000)).toBe(5_000)
    expect(sourceTimeToTimelineTime(map, 25_000)).toBe(15_000)
    // An instant inside a cut maps to where the edit resumes.
    expect(sourceTimeToTimelineTime(map, 15_000)).toBe(10_000)
    expect(timelineTimeToSourceTime(map, 15_000)).toBe(25_000)
    expect(timelineTimeToSourceTime(map, 10_000)).toBe(20_000)
  })

  it('merges overlapping cuts and ignores what falls outside the recording', () => {
    const map = buildTimeMap(30_000, [trim(5_000, 12_000), trim(10_000, 15_000), trim(28_000, 99_000)])
    expect(map.segments.map((s) => [s.sourceStartMs, s.sourceEndMs])).toEqual([
      [0, 5_000],
      [15_000, 28_000]
    ])
    expect(map.timelineDurationMs).toBe(18_000)
  })

  it('shortens a sped-up region: output = source / speed', () => {
    const map = buildTimeMap(30_000, [speed(10_000, 20_000, 2)])
    expect(map.timelineDurationMs).toBe(25_000)
    expect(sourceTimeToTimelineTime(map, 20_000)).toBe(15_000)
    expect(sourceTimeToTimelineTime(map, 14_000)).toBe(12_000)
    expect(timelineTimeToSourceTime(map, 12_000)).toBe(14_000)
    expect(timelineTimeToSourceTime(map, 20_000)).toBe(25_000)
  })

  it('combines cuts and speed regions', () => {
    const map = buildTimeMap(30_000, [trim(0, 5_000), speed(10_000, 20_000, 0.5)])
    // 5 s at 1x + 10 s at 0.5x (20 s) + 10 s at 1x
    expect(map.timelineDurationMs).toBe(35_000)
    expect(timelineTimeToSourceTime(map, 0)).toBe(5_000)
    expect(timelineTimeToSourceTime(map, 15_000)).toBe(15_000)
  })

  it('round-trips every kept instant', () => {
    const map = buildTimeMap(40_000, [trim(3_000, 9_000), speed(15_000, 25_000, 1.5), trim(30_000, 31_000)])
    for (let source = 0; source < 40_000; source += 137) {
      if (!isSourceTimeKept(map, source)) continue
      expect(timelineTimeToSourceTime(map, sourceTimeToTimelineTime(map, source))).toBeCloseTo(source, 6)
    }
  })
})

describe('nextKeptSourceTime', () => {
  const map = buildTimeMap(30_000, [trim(10_000, 20_000), trim(25_000, 30_000)])

  it('jumps over a cut and stops at the end of the edit', () => {
    expect(nextKeptSourceTime(map, 5_000)).toBe(5_000)
    expect(nextKeptSourceTime(map, 10_000)).toBe(20_000)
    expect(nextKeptSourceTime(map, 19_999)).toBe(20_000)
    expect(nextKeptSourceTime(map, 26_000)).toBeNull()
  })
})

describe('global export speed', () => {
  it('scales the whole timeline: 60 s at 2x is 30 s', () => {
    const map = buildTimeMap(60_000, [])
    expect(outputDurationMs(map, 2)).toBe(30_000)
    expect(outputDurationMs(map, 1.5)).toBe(40_000)
    expect(outputTimeToTimelineTime(1_000, 2)).toBe(2_000)
    expect(outputTimeToTimelineTime(10_000, 2)).toBe(20_000)
  })

  it('is applied after the cuts, not instead of them', () => {
    const map = buildTimeMap(60_000, [trim(0, 20_000)])
    expect(outputDurationMs(map, 2)).toBe(20_000)
    // Output 5 s → timeline 10 s → source 30 s (the first 20 s were cut).
    expect(outputTimeToSourceTime(map, 5_000, 2)).toBe(30_000)
  })
})

describe('keptSourceTime', () => {
  const map = buildTimeMap(10_000, [
    { id: 'a', type: 'trim', startMs: 0, endMs: 2000 },
    { id: 'b', type: 'trim', startMs: 8000, endMs: 10_000 }
  ])

  it('keeps a kept instant, and moves a cut one to where the edit resumes', () => {
    expect(keptSourceTime(map, 5000)).toBe(5000)
    expect(keptSourceTime(map, 0)).toBe(2000)
    expect(keptSourceTime(map, 1500)).toBe(2000)
  })

  it('stops at the last kept instant when nothing is kept after', () => {
    expect(keptSourceTime(map, 9000)).toBe(7999)
  })

  it('has nowhere to go when everything is cut', () => {
    expect(keptSourceTime(buildTimeMap(1000, [{ id: 'all', type: 'trim', startMs: 0, endMs: 1000 }]), 500)).toBe(null)
  })
})
