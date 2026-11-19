import type { ExportLoudness, MusicDucking } from '@shared/models/project'
import type { TimeMap } from '../time/timeMapping'
import { outputDurationMs } from '../time/timeMapping'
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

/** One recorded track of the mix: which FFmpeg input it is, and how loud it plays (0…1). */
export interface AudioMixTrack {
  inputIndex: number
  volume: number
  /**
   * A clip's sound laid on the recording's clock: `lengthMs` of it from `offsetMs`, starting at
   * `atMs` of the recording, silence around it. It then gets the same cuts and tempo as the rest.
   */
  place?: { atMs: number; offsetMs: number; lengthMs: number }
  /** Stretches of the recording's clock where this track is silent (a split screen playing the clip's sound alone). */
  silences?: ReadonlyArray<{ startMs: number; endMs: number }>
}

/** The filters that put a track on the recording's clock and silence what should not be heard, before the cuts. */
export function trackPrefilters(track: Pick<AudioMixTrack, 'place' | 'silences'>): string[] {
  const filters: string[] = []
  if (track.place) {
    const { atMs, offsetMs, lengthMs } = track.place
    filters.push(
      `atrim=start=${seconds(offsetMs)}:end=${seconds(offsetMs + lengthMs)}`,
      'asetpts=PTS-STARTPTS',
      FORMAT,
      ...(atMs > 0 ? [`adelay=${Math.round(atMs)}:all=1`] : []),
      'apad'
    )
  }
  for (const silence of track.silences ?? []) {
    if (silence.endMs > silence.startMs) filters.push(`volume=0:enable='between(t,${seconds(silence.startMs)},${seconds(silence.endMs)})'`)
  }
  return filters
}

/**
 * The music under the recording: which FFmpeg input it is (already looped by
 * the input options when it should be) and how it plays. It runs on the
 * finished video's clock, so it gets no cuts and no tempo change.
 */
export interface AudioMixMusic {
  inputIndex: number
  volume: number
  ducking: MusicDucking
  fadeInMs: number
  fadeOutMs: number
}

export interface AudioMix {
  tracks: readonly AudioMixTrack[]
  music: AudioMixMusic | null
  loudness: ExportLoudness
}

export interface AudioGraph {
  /** Value for FFmpeg's `-filter_complex`. */
  filter: string
  /** Label of the mixed output, for `-map`. */
  output: string
}

/**
 * How the music is pressed down while someone speaks, per setting: the
 * compressor's parameters. The thresholds sit well under a quiet
 * microphone (−34 and −40 dB RMS), so a soft voice still ducks the music,
 * while room noise, far lower, does not. Measured against the bundled
 * FFmpeg: a voice at −27 dB RMS presses the music down by about 5 dB
 * (light) and 11 dB (strong); a normal one, at −20 dB, by more.
 */
export const DUCKING_PRESETS: Record<Exclude<MusicDucking, 'off'>, { threshold: number; ratio: number; attackMs: number; releaseMs: number }> = {
  light: { threshold: 0.02, ratio: 4, attackMs: 20, releaseMs: 500 },
  strong: { threshold: 0.01, ratio: 12, attackMs: 15, releaseMs: 400 }
}

/** The loudness the social platforms play at; louder is turned down on upload, quieter sounds thin beside other posts. */
export const SOCIAL_LOUDNESS = { integratedLufs: -14, truePeakDb: -1.5, range: 11 } as const

const FORMAT = `aformat=sample_rates=${EXPORT_CONFIG.audioSampleRate}:channel_layouts=stereo`

const volumeFilter = (volume: number): string[] => (Math.abs(volume - 1) < 1e-6 ? [] : [`volume=${Number(volume.toFixed(4))}`])

/** Sums stereo streams into one, with no normalisation (see `sumTracks`). */
function sum(labels: readonly string[], output: string): string {
  const left = labels.map((_, track) => `c${track * 2}`).join('+')
  const right = labels.map((_, track) => `c${track * 2 + 1}`).join('+')
  return `${labels.join('')}amerge=inputs=${labels.length},pan=stereo|c0=${left}|c1=${right}${output}`
}

/**
 * Builds the audio side of an export. Each recorded track goes through the
 * same edit as the video: the kept segments are cut out, retimed by their
 * region speed times the global export speed, joined, and set to its
 * volume; the tracks are then summed. The music, if any, is laid under
 * them on the output clock, faded in and out, and pressed down while the
 * voice is heard when ducking is on. The whole mix may finally be brought
 * to the social platforms' loudness. Returns `null` when there is nothing
 * to mix.
 */
export function buildAudioGraph(mix: AudioMix, map: TimeMap, exportSpeed: number): AudioGraph | null {
  if ((mix.tracks.length === 0 && mix.music === null) || map.segments.length === 0) return null
  const chains: string[] = []
  const trackLabels: string[] = []

  mix.tracks.forEach((entry, track) => {
    const { inputIndex, volume } = entry
    const count = map.segments.length
    // A clip's sound is first laid on the recording's clock, and a silenced stretch muted, so the cuts below fall where they do for the rest.
    const prefilters = trackPrefilters(entry)
    let input = `[${inputIndex}:a]`
    if (prefilters.length > 0) {
      chains.push(`${input}${prefilters.join(',')}[t${track}in]`)
      input = `[t${track}in]`
    }
    const sources = count === 1 ? [input] : map.segments.map((_, index) => `[t${track}s${index}]`)
    if (count > 1) chains.push(`${input}asplit=${count}${sources.join('')}`)

    const pieces = map.segments.map((segment, index) => {
      const tempo = buildAtempoFilter(segment.speed * exportSpeed)
      const filters = [
        `atrim=start=${seconds(segment.sourceStartMs)}:end=${seconds(segment.sourceEndMs)}`,
        'asetpts=PTS-STARTPTS',
        ...(tempo ? [tempo] : []),
        ...volumeFilter(volume),
        FORMAT
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

  // The tracks are summed as `amerge` + `pan`, not `amix`: the `amix` of the
  // FFmpeg 6.0 shipped with the app sometimes never signals the end of the
  // stream when its inputs end (seen with two tracks at 1.5x), and FFmpeg then
  // waits forever after the last frame. `amerge` stacks the channels of every
  // track and `pan` adds them back into stereo, with no normalisation — the
  // same sum `amix` with `normalize=0` produced.
  let voice: string | null = null
  if (trackLabels.length === 1) voice = trackLabels[0] as string
  else if (trackLabels.length > 1) {
    chains.push(sum(trackLabels, '[voice]'))
    voice = '[voice]'
  }

  let mixed: string
  if (mix.music) {
    const { inputIndex, volume, ducking, fadeInMs, fadeOutMs } = mix.music
    const durationMs = outputDurationMs(map, exportSpeed)
    const fadeIn = Math.min(fadeInMs, durationMs)
    const fadeOut = Math.min(fadeOutMs, durationMs)
    const filters = [
      FORMAT,
      ...volumeFilter(volume),
      `atrim=end=${seconds(durationMs)}`,
      'asetpts=PTS-STARTPTS',
      ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${seconds(fadeIn)}`] : []),
      ...(fadeOut > 0 ? [`afade=t=out:st=${seconds(durationMs - fadeOut)}:d=${seconds(fadeOut)}`] : [])
    ]
    chains.push(`[${inputIndex}:a]${filters.join(',')}[music]`)

    if (voice === null) {
      mixed = '[music]'
    } else if (ducking === 'off') {
      chains.push(sum([voice, '[music]'], '[mix]'))
      mixed = '[mix]'
    } else {
      // The compressor listens to the voice (its side chain) and presses the music down while it is heard.
      const preset = DUCKING_PRESETS[ducking]
      chains.push(`${voice}asplit=2[voiceOut][voiceKey]`)
      chains.push(
        `[music][voiceKey]sidechaincompress=threshold=${preset.threshold}:ratio=${preset.ratio}:attack=${preset.attackMs}:release=${preset.releaseMs}[ducked]`
      )
      chains.push(sum(['[voiceOut]', '[ducked]'], '[mix]'))
      mixed = '[mix]'
    }
  } else {
    mixed = voice as string
  }

  if (mix.loudness === 'social') {
    const { integratedLufs, truePeakDb, range } = SOCIAL_LOUDNESS
    // `loudnorm` works at 192 kHz inside; the format is set again after it.
    chains.push(`${mixed}loudnorm=I=${integratedLufs}:TP=${truePeakDb}:LRA=${range},${FORMAT}[aout]`)
    return { filter: chains.join(';'), output: '[aout]' }
  }
  return { filter: chains.join(';'), output: mixed }
}
