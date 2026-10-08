import { describe, expect, it } from 'vitest'
import { buildTimeMap } from '../time/timeMapping'
import { buildAtempoFilter, buildAudioGraph } from './audioFilters'

/** The combined tempo of a filter chain. */
const product = (filter: string): number =>
  filter
    .split(',')
    .filter(Boolean)
    .reduce((total, part) => total * Number(part.replace('atempo=', '')), 1)

describe('buildAtempoFilter', () => {
  it('needs no filter at 1x', () => {
    expect(buildAtempoFilter(1)).toBe('')
  })

  it('uses a single filter within the supported range', () => {
    expect(buildAtempoFilter(2)).toBe('atempo=2')
    expect(buildAtempoFilter(1.5)).toBe('atempo=1.5')
    expect(buildAtempoFilter(0.5)).toBe('atempo=0.5')
  })

  it('chains filters beyond the range of a single one', () => {
    expect(buildAtempoFilter(4)).toBe('atempo=2,atempo=2')
    expect(buildAtempoFilter(3)).toBe('atempo=2,atempo=1.5')
    expect(buildAtempoFilter(0.25)).toBe('atempo=0.5,atempo=0.5')
  })

  it.each([0.3, 0.75, 1.25, 2.5, 3, 6, 10])('always multiplies out to the requested speed (%d)', (speed) => {
    const filter = buildAtempoFilter(speed)
    expect(product(filter)).toBeCloseTo(speed, 5)
    for (const part of filter.split(',')) {
      const factor = Number(part.replace('atempo=', ''))
      expect(factor).toBeGreaterThanOrEqual(0.5)
      expect(factor).toBeLessThanOrEqual(2)
    }
  })

  it('rejects nonsense', () => {
    expect(() => buildAtempoFilter(0)).toThrow(RangeError)
    expect(() => buildAtempoFilter(-2)).toThrow(RangeError)
    expect(() => buildAtempoFilter(Number.NaN)).toThrow(RangeError)
  })
})

describe('buildAudioGraph', () => {
  it('has nothing to do without audio tracks', () => {
    expect(buildAudioGraph([], buildTimeMap(10_000, []), 1)).toBeNull()
  })

  it('passes a single uncut track through at 1x', () => {
    const graph = buildAudioGraph([1], buildTimeMap(10_000, []), 1)
    expect(graph?.output).toBe('[t0]')
    expect(graph?.filter).toContain('[1:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,aformat=')
    expect(graph?.filter).not.toContain('atempo')
  })

  it('applies the global export speed with pitch-preserving tempo', () => {
    const graph = buildAudioGraph([1], buildTimeMap(10_000, []), 2)
    expect(graph?.filter).toContain('asetpts=PTS-STARTPTS,atempo=2,aformat=')
  })

  it('cuts out the kept segments, joins them and mixes the tracks', () => {
    const map = buildTimeMap(30_000, [{ id: 'cut', type: 'trim', startMs: 10_000, endMs: 20_000 }])
    const graph = buildAudioGraph([1, 2], map, 1.5)
    expect(graph?.output).toBe('[aout]')
    const filter = graph?.filter ?? ''
    expect(filter).toContain('[1:a]asplit=2[t0s0][t0s1]')
    expect(filter).toContain('[t0s0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,atempo=1.5,')
    expect(filter).toContain('[t0s1]atrim=start=20.000:end=30.000,asetpts=PTS-STARTPTS,atempo=1.5,')
    expect(filter).toContain('[t0p0][t0p1]concat=n=2:v=0:a=1[t0]')
    expect(filter).toContain('[2:a]asplit=2[t1s0][t1s1]')
    expect(filter).toContain('[t0][t1]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[aout]')
  })

  it('multiplies a speed region by the global export speed', () => {
    const map = buildTimeMap(20_000, [{ id: 'fast', type: 'speed', startMs: 0, endMs: 10_000, speed: 2 }])
    const filter = buildAudioGraph([1], map, 2)?.filter ?? ''
    // 2x region × 2x export = 4x, which needs two chained filters.
    expect(filter).toContain('atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,atempo=2,atempo=2,')
    expect(filter).toContain('atrim=start=10.000:end=20.000,asetpts=PTS-STARTPTS,atempo=2,aformat')
  })
})
