import { stat } from 'node:fs/promises'
import type { AudioAsset } from '@shared/models/session'
import type { FfmpegService } from '../export/FfmpegService'
import type { SessionStore } from '../recording/SessionStore'

const DUB_TRACK_NAMES = ['dubEn', 'dubEs', 'dubZh', 'dubPt'] as const
export type AudioTrackName = 'microphone' | 'systemAudio' | (typeof DUB_TRACK_NAMES)[number]

export function isAudioTrackName(value: unknown): value is AudioTrackName {
  return value === 'microphone' || value === 'systemAudio' || (DUB_TRACK_NAMES as readonly unknown[]).includes(value)
}

/** Points per waveform; plenty for the width of a timeline. */
const WAVEFORM_BUCKETS = 1200

/**
 * Waveform outlines for the editor's timeline. They are derived data,
 * computed on demand and kept in memory — nothing is added to the session.
 */
export class WaveformService {
  private readonly cache = new Map<string, Promise<number[]>>()

  constructor(
    private readonly ffmpeg: FfmpegService,
    private readonly sessions: SessionStore
  ) {}

  async peaks(sessionId: string, track: AudioTrackName): Promise<number[]> {
    const manifest = await this.sessions.read(sessionId)
    // A recorded track has its own length; a dubbing is as long as the recording.
    const asset: Pick<AudioAsset, 'durationMs'> | undefined =
      track === 'microphone' || track === 'systemAudio' ? manifest?.assets[track] : manifest?.assets.screen
    if (!asset) throw new Error(`Session has no ${track} track`)

    const filePath = this.sessions.trackPathOf(sessionId, track)
    // A dubbing is generated again under the same name: its outline is keyed by the file as it is now.
    const key = `${filePath}:${(await stat(filePath)).mtimeMs}`
    let pending = this.cache.get(key)
    if (!pending) {
      pending = this.ffmpeg.audioPeaks(filePath, asset.durationMs, WAVEFORM_BUCKETS)
      this.cache.set(key, pending)
      // A failure is not worth remembering.
      pending.catch(() => this.cache.delete(key))
    }
    return pending
  }
}
