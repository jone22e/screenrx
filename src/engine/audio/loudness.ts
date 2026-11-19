import { SOCIAL_LOUDNESS } from '../export/audioFilters'

/** Blocks the loudness is measured in, as in ITU-R BS.1770 (400 ms, three quarters overlapping). */
const BLOCK_SEC = 0.4
const BLOCK_STEP_SEC = 0.1
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = -10

/**
 * The integrated loudness of a mix, in LUFS, the way BS.1770 gates it
 * (quiet blocks are left out of the average) but without the K-weighting
 * filter, so a voice measures within about a dB of FFmpeg's `loudnorm`.
 * `-Infinity` for silence.
 */
export function integratedLoudness(channels: readonly Float32Array[], sampleRate: number): number {
  const first = channels[0]
  if (!first || first.length === 0) return -Infinity
  const block = Math.max(1, Math.round(BLOCK_SEC * sampleRate))
  const step = Math.max(1, Math.round(BLOCK_STEP_SEC * sampleRate))
  const powers: number[] = []
  for (let start = 0; start + block <= first.length || (start === 0 && first.length > 0); start += step) {
    const end = Math.min(first.length, start + block)
    let sum = 0
    for (const channel of channels) {
      for (let index = start; index < end; index++) sum += (channel[index] as number) ** 2
    }
    powers.push(sum / Math.max(1, end - start))
    if (end === first.length) break
  }
  const loudnessOf = (power: number): number => -0.691 + 10 * Math.log10(power + 1e-12)
  const aboveAbsolute = powers.filter((power) => loudnessOf(power) > ABSOLUTE_GATE_LUFS)
  if (aboveAbsolute.length === 0) return -Infinity
  const mean = (values: number[]): number => values.reduce((total, value) => total + value, 0) / values.length
  const relativeGate = loudnessOf(mean(aboveAbsolute)) + RELATIVE_GATE_LU
  const gated = aboveAbsolute.filter((power) => loudnessOf(power) > relativeGate)
  return gated.length === 0 ? -Infinity : loudnessOf(mean(gated))
}

/**
 * The gain that brings the mix to the social platforms' loudness (−14 LUFS)
 * without its peaks going over −1.5 dB. Quieter mixes are turned up, louder
 * ones down; silence is left alone.
 */
export function socialLoudnessGain(channels: readonly Float32Array[], sampleRate: number): number {
  const loudness = integratedLoudness(channels, sampleRate)
  if (!Number.isFinite(loudness)) return 1
  let peak = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) peak = Math.max(peak, Math.abs(channel[index] as number))
  }
  const wanted = 10 ** ((SOCIAL_LOUDNESS.integratedLufs - loudness) / 20)
  const ceiling = peak > 0 ? 10 ** (SOCIAL_LOUDNESS.truePeakDb / 20) / peak : wanted
  return Math.min(wanted, ceiling)
}
