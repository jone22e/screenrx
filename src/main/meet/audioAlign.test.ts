import { describe, expect, it } from 'vitest'
import { buildAudioFilter } from './audioAlign'

describe('buildAudioFilter', () => {
  it('cuts the head of audio that started before the clock and fixes the length', () => {
    expect(buildAudioFilter({ offsetMs: 1250, durationMs: 8000, pauses: [] })).toBe(
      '[0:a]atrim=start=1.250:end=9.250,asetpts=PTS-STARTPTS,apad=whole_dur=8.000,atrim=end=8.000[out]'
    )
  })

  it('adds silence in front of audio that started after the clock', () => {
    expect(buildAudioFilter({ offsetMs: -400, durationMs: 5000, pauses: [] })).toBe(
      '[0:a]adelay=400:all=1,atrim=start=0.000:end=5.000,asetpts=PTS-STARTPTS,apad=whole_dur=5.000,atrim=end=5.000[out]'
    )
  })

  it('cuts the stretches the recording was paused through', () => {
    // Recorded 3 s, paused 2 s (wall), recorded 4 s more: 7 s of clock; audio has 9 s after the offset.
    const filter = buildAudioFilter({ offsetMs: 500, durationMs: 7000, pauses: [{ atMs: 3000, pausedForMs: 2000 }] })
    expect(filter).toBe(
      '[0:a]asplit=2[s0][s1];' +
        '[s0]atrim=start=0.500:end=3.500,asetpts=PTS-STARTPTS[k0];' +
        '[s1]atrim=start=5.500:end=9.500,asetpts=PTS-STARTPTS[k1];' +
        '[k0][k1]concat=n=2:v=0:a=1,apad=whole_dur=7.000,atrim=end=7.000[out]'
    )
  })

  it('handles several pauses and a pause at the very start', () => {
    const filter = buildAudioFilter({
      offsetMs: 0,
      durationMs: 6000,
      pauses: [
        { atMs: 0, pausedForMs: 1000 },
        { atMs: 2000, pausedForMs: 500 }
      ]
    })
    expect(filter).toContain('[s0]atrim=start=1.000:end=3.000')
    expect(filter).toContain('[s1]atrim=start=3.500:end=7.500')
    expect(filter).toContain('concat=n=2')
  })
})
