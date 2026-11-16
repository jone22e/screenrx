import { describe, expect, it } from 'vitest'
import { buildTimeMap } from '../time/timeMapping'
import type { AudioMix } from './audioFilters'
import { buildAtempoFilter, buildAudioGraph, DUCKING_PRESETS } from './audioFilters'

/** A mix of the given FFmpeg inputs at full volume, no music, as mixed. */
const tracks = (inputIndexes: readonly number[], extra: Partial<AudioMix> = {}): AudioMix => ({
  tracks: inputIndexes.map((inputIndex) => ({ inputIndex, volume: 1 })),
  music: null,
  loudness: 'off',
  ...extra
})
const music = (extra: Partial<NonNullable<AudioMix['music']>> = {}): NonNullable<AudioMix['music']> => ({
  inputIndex: 2,
  volume: 0.25,
  ducking: 'off',
  fadeInMs: 1000,
  fadeOutMs: 2000,
  ...extra
})

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
    expect(buildAudioGraph(tracks([]), buildTimeMap(10_000, []), 1)).toBeNull()
  })

  it('passes a single uncut track through at 1x', () => {
    const graph = buildAudioGraph(tracks([1]), buildTimeMap(10_000, []), 1)
    expect(graph?.output).toBe('[t0]')
    expect(graph?.filter).toContain('[1:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,aformat=')
    expect(graph?.filter).not.toContain('atempo')
  })

  it('applies the global export speed with pitch-preserving tempo', () => {
    const graph = buildAudioGraph(tracks([1]), buildTimeMap(10_000, []), 2)
    expect(graph?.filter).toContain('asetpts=PTS-STARTPTS,atempo=2,aformat=')
  })

  it('cuts out the kept segments, joins them and mixes the tracks', () => {
    const map = buildTimeMap(30_000, [{ id: 'cut', type: 'trim', startMs: 10_000, endMs: 20_000 }])
    const graph = buildAudioGraph(tracks([1, 2]), map, 1.5)
    expect(graph?.output).toBe('[voice]')
    const filter = graph?.filter ?? ''
    expect(filter).toContain('[1:a]asplit=2[t0s0][t0s1]')
    expect(filter).toContain('[t0s0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,atempo=1.5,')
    expect(filter).toContain('[t0s1]atrim=start=20.000:end=30.000,asetpts=PTS-STARTPTS,atempo=1.5,')
    expect(filter).toContain('[t0p0][t0p1]concat=n=2:v=0:a=1[t0]')
    expect(filter).toContain('[2:a]asplit=2[t1s0][t1s1]')
    expect(filter).toContain('[t0][t1]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[voice]')
  })

  it('multiplies a speed region by the global export speed', () => {
    const map = buildTimeMap(20_000, [{ id: 'fast', type: 'speed', startMs: 0, endMs: 10_000, speed: 2 }])
    const filter = buildAudioGraph(tracks([1]), map, 2)?.filter ?? ''
    // 2x region × 2x export = 4x, which needs two chained filters.
    expect(filter).toContain('atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,atempo=2,atempo=2,')
    expect(filter).toContain('atrim=start=10.000:end=20.000,asetpts=PTS-STARTPTS,atempo=2,aformat')
  })
})

describe('buildAudioGraph volume, music and loudness', () => {
  const map = buildTimeMap(10_000, [])

  it('sets a track to its volume, and says nothing at full volume', () => {
    const quiet = buildAudioGraph(tracks([1], { tracks: [{ inputIndex: 1, volume: 0.5 }] }), map, 1)?.filter ?? ''
    expect(quiet).toContain('asetpts=PTS-STARTPTS,volume=0.5,aformat=')
    expect(buildAudioGraph(tracks([1]), map, 1)?.filter).not.toContain('volume=')
  })

  it('lays the music under the voice on the output clock, faded in and out, without cuts or tempo', () => {
    const cut = buildTimeMap(10_000, [{ id: 'c', type: 'trim', startMs: 2000, endMs: 4000 }])
    const graph = buildAudioGraph(tracks([1], { music: music() }), cut, 2)
    expect(graph?.output).toBe('[mix]')
    const filter = graph?.filter ?? ''
    // 8 s kept at 2x: the finished video lasts 4 s.
    expect(filter).toContain('[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.25,atrim=end=4.000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.000,afade=t=out:st=2.000:d=2.000[music]')
    expect(filter).toContain('[t0][music]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[mix]')
    expect(filter).not.toContain('[music]atempo')
  })

  it('presses the music down while the voice is heard', () => {
    const filter = buildAudioGraph(tracks([1], { music: music({ ducking: 'strong' }) }), map, 1)?.filter ?? ''
    const preset = DUCKING_PRESETS.strong
    expect(filter).toContain('[t0]asplit=2[voiceOut][voiceKey]')
    expect(filter).toContain(`[music][voiceKey]sidechaincompress=threshold=${preset.threshold}:ratio=${preset.ratio}:attack=${preset.attackMs}:release=${preset.releaseMs}[ducked]`)
    expect(filter).toContain('[voiceOut][ducked]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[mix]')
  })

  it('plays music alone when every recorded track is muted', () => {
    const graph = buildAudioGraph(tracks([], { music: music({ ducking: 'strong', fadeInMs: 0, fadeOutMs: 0 }) }), map, 1)
    expect(graph?.output).toBe('[music]')
    expect(graph?.filter).not.toContain('afade')
    expect(graph?.filter).not.toContain('sidechaincompress')
  })

  it('brings the whole mix to the social loudness last', () => {
    const graph = buildAudioGraph(tracks([1, 2], { loudness: 'social' }), map, 1)
    expect(graph?.output).toBe('[aout]')
    expect(graph?.filter).toMatch(/\[voice\]loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo\[aout\]$/)
  })
})
