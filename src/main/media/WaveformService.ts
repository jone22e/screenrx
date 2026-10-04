import type { AudioAsset } from '@shared/models/session'
import type { FfmpegService } from '../export/FfmpegService'
import type { SessionStore } from '../recording/SessionStore'

export type AudioTrackName = 'microphone' | 'systemAudio'

export function isAudioTrackName(value: unknown): value is AudioTrackName {
  return value === 'microphone' || value === 'systemAudio'
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
    const asset: AudioAsset | undefined = manifest?.assets[track]
    if (!asset) throw new Error(`Session has no ${track} track`)

    const filePath = this.sessions.trackPathOf(sessionId, track)
    let pending = this.cache.get(filePath)
    if (!pending) {
      pending = this.ffmpeg.audioPeaks(filePath, asset.durationMs, WAVEFORM_BUCKETS)
      this.cache.set(filePath, pending)
      // A failure is not worth remembering.
      pending.catch(() => this.cache.delete(filePath))
    }
    return pending
  }
}
