import type { TranscriptWord } from '@shared/models/captions'
import type { CaptionCue, CaptionLength } from '@shared/models/project'
import { CAPTION_CONFIG } from './captionConfig'

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const ENDS_SENTENCE = /[.!?…]["')\]]?$/

/**
 * Cleans the words of a recognizer: trimmed, in time order, and with loose
 * punctuation joined to the word before it.
 */
export function normalizeWords(raw: readonly TranscriptWord[]): TranscriptWord[] {
  const words: TranscriptWord[] = []
  const ordered = [...raw].sort((a, b) => a.startMs - b.startMs)
  for (const entry of ordered) {
    const text = entry.text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const previous = words[words.length - 1]
    if (!HAS_LETTER_OR_DIGIT.test(text)) {
      if (previous) {
        previous.text += text
        previous.endMs = Math.max(previous.endMs, entry.endMs)
      }
      continue
    }
    // Words never overlap: one that starts early is moved to where the previous one ends.
    const startMs = previous ? Math.max(entry.startMs, previous.endMs) : entry.startMs
    words.push({ text, startMs, endMs: Math.max(entry.endMs, startMs) })
  }
  return words
}

/**
 * Groups words into captions. A caption ends when it is full, at the end of
 * a sentence, or at a pause in the speech — and never lingers long after
 * its last word.
 */
export function buildCues(
  words: readonly TranscriptWord[],
  length: CaptionLength,
  createId: () => string
): CaptionCue[] {
  const maxChars = CAPTION_CONFIG.maxChars[length]
  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = []
  let chars = 0

  for (const word of words) {
    const previous = current[current.length - 1]
    if (previous) {
      const full = chars + 1 + word.text.length > maxChars
      const sentenceEnded = ENDS_SENTENCE.test(previous.text)
      const paused = word.startMs - previous.startMs > CAPTION_CONFIG.pauseMs
      if (full || sentenceEnded || paused) {
        groups.push(current)
        current = []
        chars = 0
      }
    }
    chars += (current.length > 0 ? 1 : 0) + word.text.length
    current.push(word)
  }
  if (current.length > 0) groups.push(current)

  const cues: CaptionCue[] = []
  groups.forEach((group, index) => {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) return
    const nextStartMs = groups[index + 1]?.[0]?.startMs ?? Infinity
    const endMs = Math.min(last.endMs, last.startMs + CAPTION_CONFIG.maxLingerMs, nextStartMs)
    if (endMs <= first.startMs) return
    cues.push({
      id: createId(),
      startMs: first.startMs,
      endMs,
      text: group.map((word) => word.text).join(' ')
    })
  })
  return cues
}

/** The caption on screen at `timeMs` (source time), if any. `cues` must be sorted by start time. */
export function cueAt(cues: readonly CaptionCue[], timeMs: number): CaptionCue | null {
  let low = 0
  let high = cues.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const cue = cues[middle]
    if (!cue) return null
    if (timeMs < cue.startMs) high = middle - 1
    else if (timeMs >= cue.endMs) low = middle + 1
    else return cue
  }
  return null
}
