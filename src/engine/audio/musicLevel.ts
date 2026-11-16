import type { TranscriptWord } from '@shared/models/captions'
import type { MusicDucking, MusicSettings } from '@shared/models/project'

/** A stretch of the recording (source time) in which someone is speaking. */
export interface SpeechSpan {
  startMs: number
  endMs: number
}

/** Tunables of how the preview imitates the export's ducking, which the export does by listening to the voice. */
export const MUSIC_PREVIEW = {
  /** Two words closer than this are one stretch of speech. */
  bridgeMs: 300,
  /** The music level under speech, per ducking setting, relative to its own volume. */
  duckGain: { off: 1, light: 0.4, strong: 0.18 } satisfies Record<MusicDucking, number>,
  /** How fast the music goes down when speech starts, and comes back when it ends. */
  attackMs: 60,
  releaseMs: 450
} as const

/**
 * Where speech is, from the words of a transcript: words that follow each
 * other closely are joined, so the music does not bob between every two.
 */
export function speechSpans(words: readonly TranscriptWord[]): SpeechSpan[] {
  const spans: SpeechSpan[] = []
  for (const word of [...words].sort((a, b) => a.startMs - b.startMs)) {
    const previous = spans[spans.length - 1]
    if (previous && word.startMs - previous.endMs <= MUSIC_PREVIEW.bridgeMs) {
      previous.endMs = Math.max(previous.endMs, word.endMs)
    } else {
      spans.push({ startMs: word.startMs, endMs: word.endMs })
    }
  }
  return spans
}

/** Whether someone is speaking at `sourceMs`. `spans` must be sorted and non-overlapping. */
export function isSpeakingAt(spans: readonly SpeechSpan[], sourceMs: number): boolean {
  let low = 0
  let high = spans.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const span = spans[middle] as SpeechSpan
    if (sourceMs < span.startMs) high = middle - 1
    else if (sourceMs >= span.endMs) low = middle + 1
    else return true
  }
  return false
}

/**
 * The music's gain at an instant of the finished video, before smoothing:
 * its volume, through the fades at either end, pressed down while someone
 * speaks.
 */
export function musicTargetGain(music: MusicSettings, outputMs: number, outputDurationMs: number, speaking: boolean): number {
  const fadeIn = music.fadeInMs > 0 ? Math.min(1, outputMs / music.fadeInMs) : 1
  const fadeOut = music.fadeOutMs > 0 ? Math.min(1, (outputDurationMs - outputMs) / music.fadeOutMs) : 1
  const duck = speaking ? MUSIC_PREVIEW.duckGain[music.ducking] : 1
  return clamp01(music.volume * clamp01(fadeIn) * clamp01(fadeOut) * duck)
}

/**
 * One step of the smoothing between the gain now and the gain wanted, over
 * `elapsedMs`: quick on the way down (the voice must not be stepped on),
 * gentle on the way back up.
 */
export function approachGain(current: number, target: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return current
  const timeMs = target < current ? MUSIC_PREVIEW.attackMs : MUSIC_PREVIEW.releaseMs
  const share = 1 - Math.exp(-elapsedMs / timeMs)
  return current + (target - current) * share
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)
