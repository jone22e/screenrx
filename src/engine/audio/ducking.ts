import type { MusicDucking } from '@shared/models/project'
import { DUCKING_PRESETS } from '../export/audioFilters'

/** How often the voice is measured; the gain changes between measurements are interpolated by the caller. */
export const DUCKING_BLOCK_SEC = 0.005

/**
 * The gain the music plays at, block by block, while the voice is heard:
 * what FFmpeg's `sidechaincompress` does in the desktop export, done here
 * for the web one. The voice's level is measured per block (RMS); above the
 * preset's threshold the music is pressed down by the preset's ratio, going
 * down at the attack's pace and coming back at the release's.
 */
export function duckingGains(voice: Float32Array, sampleRate: number, ducking: MusicDucking): Float32Array {
  const block = Math.max(1, Math.round(DUCKING_BLOCK_SEC * sampleRate))
  const blocks = Math.ceil(voice.length / block)
  const gains = new Float32Array(blocks).fill(1)
  if (ducking === 'off') return gains
  const preset = DUCKING_PRESETS[ducking]
  const thresholdDb = 20 * Math.log10(preset.threshold)
  const attack = 1 - Math.exp(-DUCKING_BLOCK_SEC / (preset.attackMs / 1000))
  const release = 1 - Math.exp(-DUCKING_BLOCK_SEC / (preset.releaseMs / 1000))
  let reductionDb = 0
  for (let index = 0; index < blocks; index++) {
    let energy = 0
    const start = index * block
    const end = Math.min(voice.length, start + block)
    for (let sample = start; sample < end; sample++) energy += (voice[sample] as number) ** 2
    const levelDb = 20 * Math.log10(Math.sqrt(energy / Math.max(1, end - start)) + 1e-9)
    const wanted = levelDb > thresholdDb ? (levelDb - thresholdDb) * (1 - 1 / preset.ratio) : 0
    reductionDb += (wanted - reductionDb) * (wanted > reductionDb ? attack : release)
    gains[index] = 10 ** (-reductionDb / 20)
  }
  return gains
}
