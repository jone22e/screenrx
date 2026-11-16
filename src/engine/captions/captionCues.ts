import type { TranscriptWord } from '@shared/models/captions'
import type { CaptionCue, CaptionLength, CaptionSettings, CaptionWord } from '@shared/models/project'
import { spreadWords } from '@shared/models/project'
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
  const maxWords = CAPTION_CONFIG.maxWords[length]
  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = []
  let chars = 0

  for (const word of words) {
    const previous = current[current.length - 1]
    if (previous) {
      const full = chars + 1 + word.text.length > maxChars || current.length >= maxWords
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
    const natural = Math.min(last.endMs, last.startMs + CAPTION_CONFIG.maxLingerMs, nextStartMs)
    // Straight into the next caption when it follows closely: a blank between two would blink.
    const endMs = nextStartMs - natural < CAPTION_CONFIG.bridgeGapMs ? nextStartMs : natural
    if (endMs <= first.startMs) return
    cues.push({
      id: createId(),
      startMs: first.startMs,
      endMs,
      text: group.map((word) => word.text).join(' '),
      words: group.map((word) => ({
        text: word.text,
        startMs: Math.min(word.startMs, endMs),
        endMs: Math.min(Math.max(word.endMs, word.startMs), endMs)
      }))
    })
  })
  return cues
}

/**
 * The caption with its text replaced. The words keep their timing when there
 * are as many as before (a correction); otherwise they are spread evenly.
 */
export function rewordCue(cue: CaptionCue, text: string): CaptionCue {
  const tokens = text.split(/\s+/).filter((token) => token !== '')
  const words =
    tokens.length === cue.words.length
      ? cue.words.map((word, index) => ({ ...word, text: tokens[index] as string }))
      : spreadWords(text, cue.startMs, cue.endMs)
  return { ...cue, text, words }
}

/** The caption moved or resized to `span`, its words carried along in proportion. */
export function fitCue(cue: CaptionCue, span: { startMs: number; endMs: number }): CaptionCue {
  const scale = (span.endMs - span.startMs) / Math.max(cue.endMs - cue.startMs, 1)
  const words = cue.words.map((word) => ({
    ...word,
    startMs: span.startMs + (word.startMs - cue.startMs) * scale,
    endMs: span.startMs + (word.endMs - cue.startMs) * scale
  }))
  return { ...cue, ...span, words }
}

/** The caption clipped to end at `endMs` at the latest, words included. */
export function clipCue(cue: CaptionCue, endMs: number): CaptionCue {
  if (cue.endMs <= endMs) return cue
  return {
    ...cue,
    endMs,
    words: cue.words.map((word) => ({ ...word, startMs: Math.min(word.startMs, endMs), endMs: Math.min(word.endMs, endMs) }))
  }
}

/**
 * Which of the caption's words is being spoken at `timeMs`: the last one
 * begun, so the mark stays on a word through the silence after it. `null`
 * when the caption has no words.
 */
export function activeWordIndex(words: readonly CaptionWord[], timeMs: number): number | null {
  if (words.length === 0) return null
  let index = 0
  for (let candidate = 1; candidate < words.length; candidate++) {
    if ((words[candidate] as CaptionWord).startMs <= timeMs) index = candidate
    else break
  }
  return index
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

/**
 * The text a caption shows: its translation into the chosen language when
 * there is one, otherwise what was spoken.
 */
export function cueText(captions: Pick<CaptionSettings, 'language' | 'translations'>, cue: CaptionCue): string {
  const translated = captions.language ? captions.translations[captions.language]?.[cue.id] : undefined
  return translated ?? cue.text
}

/** When in a caption an instant falls, for the word-by-word styles and the entrance animation. */
export interface CaptionTiming {
  /** The word being spoken, as an index into the text's words; `null` when that is unknown. */
  activeWord: number | null
  /** How long the caption has been on screen. */
  sinceStartMs: number
  /** How long the active word has been spoken. */
  sinceWordMs: number
}

export interface CaptionInstant extends CaptionTiming {
  text: string
}

/**
 * The caption on screen at `timeMs` (source time), in the chosen language,
 * and where in it the instant falls; `null` when there is none. A translation
 * has no timing of its own, so its words are not told apart.
 */
export function captionAt(captions: CaptionSettings, timeMs: number): CaptionInstant | null {
  if (!captions.visible) return null
  const cue = cueAt(captions.cues, timeMs)
  if (!cue) return null
  const text = cueText(captions, cue)
  const timed = captions.language === null && cue.words.length === text.split(/\s+/).filter((t) => t !== '').length
  const activeWord = timed ? activeWordIndex(cue.words, timeMs) : null
  const word = activeWord === null ? null : cue.words[activeWord]
  return {
    text,
    activeWord,
    sinceStartMs: timeMs - cue.startMs,
    sinceWordMs: word ? Math.max(0, timeMs - word.startMs) : timeMs - cue.startMs
  }
}
