import type { SessionPause } from '@shared/models/session'

export interface AudioAlignment {
  /**
   * Where the recording clock's zero falls in the captured audio, in ms: positive when the audio
   * started earlier (that much is cut from its start), negative when it started later (silence is
   * added in front).
   */
  offsetMs: number
  /** Length of the recording on its clock, pauses excluded: the track lasts exactly this long. */
  durationMs: number
  /** Pauses on the recording clock; the audio kept running through them, so they are cut out. */
  pauses: readonly SessionPause[]
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

/**
 * The FFmpeg filter graph that turns audio captured continuously (in wall time) into a track on the
 * recording's own timeline: starts at the clock's zero, has no audio for the paused stretches and
 * lasts exactly the recording's duration. Pure, so the arithmetic is tested without FFmpeg.
 */
export function buildAudioFilter({ offsetMs, durationMs, pauses }: AudioAlignment): string {
  // Audio that began after the clock's zero is pushed later with silence, then treated as aligned.
  const delay = offsetMs < 0 ? `adelay=${Math.round(-offsetMs)}:all=1,` : ''
  let cursor = Math.max(0, offsetMs)

  // Kept stretches in captured-audio time: from each pause's end to the next pause's start.
  const kept: Array<{ from: number; to: number }> = []
  let recorded = 0
  for (const pause of [...pauses].sort((a, b) => a.atMs - b.atMs)) {
    const length = Math.max(0, pause.atMs - recorded)
    if (length > 0) kept.push({ from: cursor, to: cursor + length })
    cursor += length + pause.pausedForMs
    recorded = Math.max(recorded, pause.atMs)
  }
  kept.push({ from: cursor, to: cursor + Math.max(0, durationMs - recorded) })

  const trim = (range: { from: number; to: number }): string =>
    `atrim=start=${seconds(range.from)}:end=${seconds(range.to)},asetpts=PTS-STARTPTS`
  const first = kept[0]
  const graph =
    kept.length === 1 && first
      ? `[0:a]${delay}${trim(first)}`
      : `[0:a]${delay}asplit=${kept.length}${kept.map((_, i) => `[s${i}]`).join('')};` +
        `${kept.map((range, i) => `[s${i}]${trim(range)}[k${i}]`).join(';')};` +
        `${kept.map((_, i) => `[k${i}]`).join('')}concat=n=${kept.length}:v=0:a=1`
  // Silence completes whatever the capture did not cover, so the track is exactly as long as the clock.
  return `${graph},apad=whole_dur=${seconds(durationMs)},atrim=end=${seconds(durationMs)}[out]`
}
