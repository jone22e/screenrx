/**
 * Edits proposed to the user — by an AI reading the transcript — and never
 * applied on their own. A suggestion is not part of the project: accepting
 * one turns it into an ordinary cut, which is.
 */

/** Why a stretch of speech could go. */
export type CutSuggestionKind = 'retake' | 'filler' | 'off-topic'

export const CUT_SUGGESTION_KINDS: readonly CutSuggestionKind[] = ['retake', 'filler', 'off-topic']

/** A stretch of the recording (source time) proposed for cutting. */
export interface CutSuggestion {
  id: string
  startMs: number
  endMs: number
  kind: CutSuggestionKind
  /** One short sentence for the user. */
  reason: string
  /** The words that would be removed. */
  text: string
}

export interface CutSuggestionResult {
  suggestions: CutSuggestion[]
  /** Words of the transcript that were analysed; fewer than `totalWords` for a very long recording. */
  analyzedWords: number
  totalWords: number
}
