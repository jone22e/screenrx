import type { TranscriptWord } from '@shared/models/captions'
import type { TimeSpan } from '../timeline/spanEditing'

/** Tunables of the pauses the assistant offers to remove. */
export const PAUSE_CUT = {
  /** A silence between two words this long is a pause worth cutting. */
  minPauseMs: 1500,
  /** Left on each side of a cut pause, so the words around it keep their breath. */
  marginMs: 200
} as const

/**
 * The long silences between words, as stretches to cut — already shorter
 * than the silence by the margins — leaving out those a cut already covers.
 */
export function longPauses(words: readonly TranscriptWord[], cuts: readonly TimeSpan[]): TimeSpan[] {
  const pauses: TimeSpan[] = []
  for (let index = 0; index + 1 < words.length; index++) {
    const word = words[index] as TranscriptWord
    const next = words[index + 1] as TranscriptWord
    if (next.startMs - word.endMs < PAUSE_CUT.minPauseMs) continue
    const span = { startMs: word.endMs + PAUSE_CUT.marginMs, endMs: next.startMs - PAUSE_CUT.marginMs }
    if (span.endMs <= span.startMs) continue
    if (cuts.some((cut) => cut.startMs <= span.startMs && cut.endMs >= span.endMs)) continue
    pauses.push(span)
  }
  return pauses
}

/** How much time a list of stretches adds up to. */
export const totalMs = (spans: readonly TimeSpan[]): number =>
  spans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0)
