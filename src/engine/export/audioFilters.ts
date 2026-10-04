import type { TimeMap } from '../time/timeMapping'
import { EXPORT_CONFIG } from './exportConfig'

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

/**
 * The FFmpeg filter that changes tempo by `speed` while preserving pitch —
 * voices do not get higher when the video is sped up. Speeds outside what a
 * single `atempo` handles well are split into a chain whose product is the
 * requested speed (4x → `atempo=2,atempo=2`). Returns `''` for 1x.
 */
export function buildAtempoFilter(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError(`Invalid tempo ${speed}`)
  const { min, max } = EXPORT_CONFIG.atempoRange
  const factors: number[] = []
  let remaining = speed
  while (remaining > max + 1e-9) {
    factors.push(max)
    remaining /= max
  }
  while (remaining < min - 1e-9) {
    factors.push(min)
    remaining /= min
  }
  if (Math.abs(remaining - 1) > 1e-9) factors.push(remaining)
  return factors.map((factor) => `atempo=${Number(factor.toFixed(6))}`).join(',')
}

export interface AudioGraph {
  /** Value for FFmpeg's `-filter_complex`. */
  filter: string
  /** Label of the mixed output, for `-map`. */
  output: string
}

/**
 * Builds the audio side of an export for the given FFmpeg input indexes
 * (one per audio track of the session). Each track goes through the same
 * edit as the video: the kept segments are cut out, retimed by their region
 * speed times the global export speed, and joined; the tracks are then
 * mixed. Returns `null` when there is nothing to mix.
 */
export function buildAudioGraph(
  inputIndexes: readonly number[],
  map: TimeMap,
  exportSpeed: number
): AudioGraph | null {
  if (inputIndexes.length === 0 || map.segments.length === 0) return null
  const format = `aformat=sample_rates=${EXPORT_CONFIG.audioSampleRate}:channel_layouts=stereo`
  const chains: string[] = []
  const trackLabels: string[] = []

  inputIndexes.forEach((inputIndex, track) => {
    const count = map.segments.length
    const sources =
      count === 1 ? [`[${inputIndex}:a]`] : map.segments.map((_, index) => `[t${track}s${index}]`)
    if (count > 1) chains.push(`[${inputIndex}:a]asplit=${count}${sources.join('')}`)

    const pieces = map.segments.map((segment, index) => {
      const tempo = buildAtempoFilter(segment.speed * exportSpeed)
      const filters = [
        `atrim=start=${seconds(segment.sourceStartMs)}:end=${seconds(segment.sourceEndMs)}`,
        'asetpts=PTS-STARTPTS',
        ...(tempo ? [tempo] : []),
        format
      ]
      const label = `[t${track}p${index}]`
      chains.push(`${sources[index]}${filters.join(',')}${label}`)
      return label
    })

    const trackLabel = `[t${track}]`
    chains.push(
      count === 1
        ? `${pieces[0]}anull${trackLabel}`
        : `${pieces.join('')}concat=n=${count}:v=0:a=1${trackLabel}`
    )
    trackLabels.push(trackLabel)
  })

  if (trackLabels.length === 1) {
    return { filter: chains.join(';'), output: trackLabels[0] as string }
  }
  chains.push(`${trackLabels.join('')}amix=inputs=${trackLabels.length}:normalize=0[aout]`)
  return { filter: chains.join(';'), output: '[aout]' }
}
