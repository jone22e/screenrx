import type { ExportLoudness, MusicSettings } from '@shared/models/project'
import type { TimeMap } from '../time/timeMapping'
import { DUCKING_BLOCK_SEC, duckingGains } from './ducking'
import { socialLoudnessGain } from './loudness'
import { stretchChannels } from './timeStretch'

/** Decoded audio: one array per channel, all at `sampleRate`. */
export interface PcmAudio {
  channels: readonly Float32Array[]
  sampleRate: number
}

/** A recorded track as it goes into the mix: already decoded, at its volume (0…1). */
export interface MixdownTrack extends PcmAudio {
  volume: number
}

export interface MixdownInput {
  tracks: readonly MixdownTrack[]
  /** The music under the recording, on the finished video's clock: no cuts, no tempo change. */
  music: (PcmAudio & { settings: MusicSettings }) | null
  map: TimeMap
  exportSpeed: number
  loudness: ExportLoudness
  /** Length of the finished video. */
  outputDurationMs: number
  sampleRate: number
}

/**
 * The sound of an exported video, mixed in memory: what `buildAudioGraph`
 * has FFmpeg do on the desktop, done here for the web editor. Each track
 * goes through the edit (the kept segments, retimed by their speed and the
 * export's, laid end to end) at its volume; the tracks are summed; the music
 * is laid under them, faded in and out and pressed down while the voice is
 * heard; the mix may finally be brought to the social platforms' loudness.
 * Returns stereo at `sampleRate`, clipped to ±1.
 */
export function mixdown(input: MixdownInput): [Float32Array, Float32Array] {
  const { sampleRate, exportSpeed, map } = input
  const length = Math.max(1, Math.round((input.outputDurationMs / 1000) * sampleRate))
  const voice: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)]

  for (const track of input.tracks) {
    if (track.volume <= 0 || track.channels.length === 0) continue
    const stereo = asStereo(track.channels)
    for (const segment of map.segments) {
      const from = Math.min(stereo[0].length, Math.round((segment.sourceStartMs / 1000) * sampleRate))
      const to = Math.min(stereo[0].length, Math.round((segment.sourceEndMs / 1000) * sampleRate))
      if (to <= from) continue
      const speed = segment.speed * exportSpeed
      const pieces = stretchChannels(
        stereo.map((channel) => channel.subarray(from, to)),
        speed,
        sampleRate
      )
      const at = Math.round((segment.timelineStartMs / exportSpeed / 1000) * sampleRate)
      for (const [channelIndex, piece] of pieces.entries()) {
        const target = voice[channelIndex] as Float32Array
        for (let index = 0; index < piece.length && at + index < length; index++) {
          if (at + index < 0) continue
          target[at + index] = (target[at + index] ?? 0) + (piece[index] as number) * track.volume
        }
      }
    }
  }

  const mix: [Float32Array, Float32Array] = [voice[0].slice(), voice[1].slice()]
  const music = input.music
  if (music && music.settings.volume > 0 && music.channels.length > 0 && (music.channels[0]?.length ?? 0) > 0) {
    const stereo = asStereo(music.channels)
    const musicLength = stereo[0].length
    const { settings } = music
    const fadeIn = Math.round((Math.min(settings.fadeInMs, input.outputDurationMs) / 1000) * sampleRate)
    const fadeOut = Math.round((Math.min(settings.fadeOutMs, input.outputDurationMs) / 1000) * sampleRate)
    // The voice, summed to one channel, is what the ducking listens to.
    const mono = new Float32Array(length)
    for (let index = 0; index < length; index++) mono[index] = ((voice[0][index] as number) + (voice[1][index] as number)) / 2
    const gains = duckingGains(mono, sampleRate, settings.ducking)
    const block = Math.max(1, Math.round(DUCKING_BLOCK_SEC * sampleRate))
    for (let index = 0; index < length; index++) {
      const position = settings.loop ? index % musicLength : index
      if (position >= musicLength) break
      let gain = settings.volume * (gains[Math.floor(index / block)] ?? 1)
      if (fadeIn > 0 && index < fadeIn) gain *= index / fadeIn
      if (fadeOut > 0 && index >= length - fadeOut) gain *= (length - index) / fadeOut
      mix[0][index] = (mix[0][index] ?? 0) + (stereo[0][position] as number) * gain
      mix[1][index] = (mix[1][index] ?? 0) + (stereo[1][position] as number) * gain
    }
  }

  const gain = input.loudness === 'social' ? socialLoudnessGain(mix, sampleRate) : 1
  for (const channel of mix) {
    for (let index = 0; index < length; index++) {
      channel[index] = Math.max(-1, Math.min(1, (channel[index] as number) * gain))
    }
  }
  return mix
}

/** Two channels out of one or more: mono is heard on both sides, extra channels are left out. */
function asStereo(channels: readonly Float32Array[]): [Float32Array, Float32Array] {
  const left = channels[0] as Float32Array
  return [left, channels[1] ?? left]
}
