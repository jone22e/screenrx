import { describe, expect, it } from 'vitest'
import { DEFAULT_MUSIC } from '@shared/models/project'
import { buildTimeMap } from '../time/timeMapping'
import { duckingGains } from './ducking'
import { integratedLoudness, socialLoudnessGain } from './loudness'
import { mixdown } from './mixdown'
import { stretchChannels } from './timeStretch'

const RATE = 8000

const sine = (seconds: number, frequency: number, amplitude = 0.5): Float32Array => {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (let index = 0; index < samples.length; index++) samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE)
  return samples
}

const zeroCrossings = (samples: Float32Array): number => {
  let count = 0
  for (let index = 1; index < samples.length; index++) {
    if ((samples[index - 1] as number) < 0 !== (samples[index] as number) < 0) count++
  }
  return count
}

const rms = (samples: Float32Array, from = 0, to = samples.length): number => {
  let sum = 0
  for (let index = from; index < to; index++) sum += (samples[index] as number) ** 2
  return Math.sqrt(sum / Math.max(1, to - from))
}

describe('stretchChannels', () => {
  it('leaves 1x as it is', () => {
    const tone = sine(0.5, 440)
    const [out] = stretchChannels([tone], 1, RATE)
    expect(out).toHaveLength(tone.length)
    expect(out?.[1000]).toBeCloseTo(tone[1000] as number, 6)
  })

  it('halves the length at 2x and keeps the pitch', () => {
    const tone = sine(1, 440)
    const [out] = stretchChannels([tone], 2, RATE)
    expect(out).toHaveLength(RATE / 2)
    // A 440 Hz tone crosses zero 880 times a second: half a second of it, still at 440 Hz, about 440 times.
    expect(zeroCrossings(out as Float32Array)).toBeGreaterThan(400)
    expect(zeroCrossings(out as Float32Array)).toBeLessThan(480)
    expect(rms(out as Float32Array, 200, (out as Float32Array).length - 200)).toBeCloseTo(rms(tone), 1)
  })

  it('doubles the length at 0.5x and keeps stereo in step', () => {
    const left = sine(0.5, 300)
    const right = sine(0.5, 300, 0.25)
    const [outLeft, outRight] = stretchChannels([left, right], 0.5, RATE)
    expect(outLeft).toHaveLength(RATE)
    expect(outRight).toHaveLength(RATE)
    for (let index = 500; index < 1000; index++) {
      expect(outRight?.[index]).toBeCloseTo(((outLeft?.[index] as number) ?? 0) / 2, 3)
    }
  })
})

describe('duckingGains', () => {
  it('presses the music down while the voice is loud and lets it back after', () => {
    // Half a second of voice, then two seconds of silence for the music to come all the way back.
    const voice = new Float32Array(RATE * 2.5)
    voice.set(sine(0.5, 200, 0.3), 0)
    const gains = duckingGains(voice, RATE, 'strong')
    const blocksPerSecond = 200
    expect(gains[Math.round(0.4 * blocksPerSecond)]).toBeLessThan(0.5)
    expect(gains[gains.length - 1]).toBeGreaterThan(0.9)
    expect(duckingGains(voice, RATE, 'off').every((gain) => gain === 1)).toBe(true)
  })
})

describe('loudness', () => {
  it('measures a full-scale sine near −3 LUFS and silence as none', () => {
    const tone = sine(2, 440, 1)
    expect(integratedLoudness([tone, tone], RATE)).toBeCloseTo(-0.691 + 10 * Math.log10(1), 0)
    expect(integratedLoudness([new Float32Array(RATE)], RATE)).toBe(-Infinity)
  })

  it('brings a quiet mix up to −14 LUFS without passing the peak ceiling', () => {
    const quiet = sine(2, 440, 0.05)
    const gain = socialLoudnessGain([quiet, quiet], RATE)
    const louder = quiet.map((sample) => sample * gain)
    expect(integratedLoudness([louder, louder], RATE)).toBeCloseTo(-14, 0)
    const loud = sine(2, 440, 0.99)
    expect(socialLoudnessGain([loud, loud], RATE) * 0.99).toBeLessThanOrEqual(10 ** (-1.5 / 20) + 1e-6)
  })
})

describe('mixdown', () => {
  it('cuts, retimes and lays the segments end to end on the output clock', () => {
    // 3 s: the middle second cut, the last second at 2x → 1.5 s of timeline, exported at 1x.
    const tone = sine(3, 440)
    const map = buildTimeMap(3000, [
      { id: 'cut', type: 'trim', startMs: 1000, endMs: 2000, transition: 'cut' },
      { id: 'fast', type: 'speed', startMs: 2000, endMs: 3000, speed: 2 }
    ])
    const [left, right] = mixdown({
      tracks: [{ channels: [tone], sampleRate: RATE, volume: 1 }],
      music: null,
      map,
      exportSpeed: 1,
      loudness: 'off',
      outputDurationMs: map.timelineDurationMs,
      sampleRate: RATE
    })
    expect(left).toHaveLength(RATE * 1.5)
    expect(rms(left, 100, RATE - 100)).toBeCloseTo(rms(tone), 1)
    expect(rms(left, RATE + 100, RATE * 1.5 - 100)).toBeCloseTo(rms(tone), 1)
    expect(right[2000]).toBeCloseTo(left[2000] as number, 6)
  })

  it('lays the music under the voice, looped and faded, at its volume', () => {
    const map = buildTimeMap(2000, [])
    const music = sine(0.5, 100, 1)
    const [left] = mixdown({
      tracks: [],
      music: { channels: [music], sampleRate: RATE, settings: { ...DEFAULT_MUSIC, volume: 0.5, ducking: 'off', fadeInMs: 500, fadeOutMs: 500 } },
      map,
      exportSpeed: 1,
      loudness: 'off',
      outputDurationMs: 2000,
      sampleRate: RATE
    })
    expect(left).toHaveLength(RATE * 2)
    // Looped past its own half second, at half volume, with the ends faded.
    expect(rms(left, RATE * 0.75, RATE * 1.25)).toBeCloseTo(rms(music) * 0.5, 1)
    expect(Math.abs(left[10] as number)).toBeLessThan(0.02)
    expect(Math.abs(left[RATE * 2 - 10] as number)).toBeLessThan(0.02)
  })

  it('halves the output at a 2x export speed', () => {
    const map = buildTimeMap(2000, [])
    const [left] = mixdown({
      tracks: [{ channels: [sine(2, 440)], sampleRate: RATE, volume: 1 }],
      music: null,
      map,
      exportSpeed: 2,
      loudness: 'social',
      outputDurationMs: 1000,
      sampleRate: RATE
    })
    expect(left).toHaveLength(RATE)
    expect(integratedLoudness([left, left], RATE)).toBeCloseTo(-14, 0)
  })
})
