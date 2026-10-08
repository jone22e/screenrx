/**
 * Keeping a separately recorded track (audio, webcam) in step with the master
 * track during playback. Audio that is being heard must never be bent to catch
 * up: changing the playback rate is audible as a warble (the browser stretches
 * the sound), and a track that sits a constant distance behind — the time audio
 * takes to come out after a seek — would be chased forever. So a small slip is
 * left alone, and only a large one is repaired, by a seek.
 */
export const TRACK_SYNC = {
  /** A slip up to this (seconds of recording, at speed 1) is left alone. */
  toleranceS: 0.3
} as const

export type TrackCorrection = 'none' | 'seek'

/**
 * What to do with a track that is `driftS` seconds off the master (positive:
 * the track is ahead), while both play at `speed`. The tolerance is in time as
 * heard, so it widens with the speed, as the same slip then covers more of the
 * recording.
 */
export function correctTrack(driftS: number, speed: number): TrackCorrection {
  return Math.abs(driftS) > TRACK_SYNC.toleranceS * Math.max(1, speed) ? 'seek' : 'none'
}
