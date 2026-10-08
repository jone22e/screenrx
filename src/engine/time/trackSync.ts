/**
 * Keeping a separately recorded track (audio, webcam) in step with the master
 * track during playback. Seeking a media element is audible — the decoder is
 * flushed and the sound cuts out for a moment — so a small slip is corrected
 * by bending the track's playback rate a little, and only a large one by a seek.
 */
export const TRACK_SYNC = {
  /** A slip up to this (seconds of recording, at speed 1) is left alone. */
  deadbandS: 0.04,
  /** A slip beyond this is too far to catch up by rate: the track is seeked. */
  seekThresholdS: 0.5,
  /** How much the rate is bent to catch up or fall back; small enough to go unnoticed. */
  nudge: 0.04
} as const

export type TrackCorrection = { kind: 'rate'; rate: number } | { kind: 'seek' }

/**
 * What to do with a track that is `driftS` seconds off the master (positive:
 * the track is ahead), while both play at `speed`. The thresholds are in time
 * as heard, so they widen with the speed, as the same slip then covers more of
 * the recording.
 */
export function correctTrack(driftS: number, speed: number): TrackCorrection {
  const scale = Math.max(1, speed)
  const slip = Math.abs(driftS)
  if (slip > TRACK_SYNC.seekThresholdS * scale) return { kind: 'seek' }
  if (slip <= TRACK_SYNC.deadbandS * scale) return { kind: 'rate', rate: speed }
  const direction = driftS > 0 ? -1 : 1
  return { kind: 'rate', rate: round(speed * (1 + direction * TRACK_SYNC.nudge)) }
}

/** Keeps rates to a resolution media elements can honour, so equal corrections compare equal. */
function round(rate: number): number {
  return Math.round(rate * 10_000) / 10_000
}
