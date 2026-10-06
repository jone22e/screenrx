import type { TranscriptWord } from '@shared/models/captions'
import { DUB_CONFIG } from './dubConfig'

/** A caption as dubbing sees it: when it is on screen and what it says in the target language. */
export interface DubSourceCue {
  startMs: number
  endMs: number
  text: string
}

/** One stretch of speech to synthesize: a sentence, or what is said in one breath. */
export interface DubUnit {
  id: string
  /** When the speech begins, on the recording's clock (source time). */
  startMs: number
  /** When the next stretch begins: the speech should be over by then. */
  slotEndMs: number
  text: string
}

const ENDS_SENTENCE = /[.!?…。！？]["'”’)\]]?$/
/** Languages written without spaces are joined without one. */
const NO_SPACES = /[぀-ヿ㐀-䶿一-鿿]/

const join = (texts: readonly string[]): string =>
  texts.reduce((whole, text) => {
    if (whole === '') return text
    const glued = NO_SPACES.test(whole.slice(-1)) || NO_SPACES.test(text.charAt(0))
    return glued ? `${whole}${text}` : `${whole} ${text}`
  }, '')

/**
 * Groups captions into the stretches a voice speaks. Captions are cut for
 * reading — three words can be one caption — but a voice needs whole
 * sentences to sound natural, so consecutive captions are joined until a
 * sentence ends, the speaker pauses, or the stretch gets long.
 *
 * Each stretch begins when its first caption does, and should be over when
 * the next stretch begins.
 */
export function buildDubUnits(cues: readonly DubSourceCue[], durationMs: number): DubUnit[] {
  const groups: DubSourceCue[][] = []
  let current: DubSourceCue[] = []

  for (const cue of cues) {
    if (cue.text.trim() === '') continue
    const previous = current[current.length - 1]
    const first = current[0]
    if (previous && first) {
      const sentenceEnded = ENDS_SENTENCE.test(previous.text.trim())
      const paused = cue.startMs - previous.endMs > DUB_CONFIG.pauseBetweenUnitsMs
      const long = cue.endMs - first.startMs > DUB_CONFIG.maxUnitMs
      if (sentenceEnded || paused || long) {
        groups.push(current)
        current = []
      }
    }
    current.push(cue)
  }
  if (current.length > 0) groups.push(current)

  return groups.slice(0, DUB_CONFIG.maxUnits).map((group, index) => {
    const startMs = group[0]?.startMs ?? 0
    return {
      id: `unit-${index + 1}`,
      startMs,
      slotEndMs: groups[index + 1]?.[0]?.startMs ?? Math.max(durationMs, startMs),
      text: join(group.map((cue) => cue.text.replace(/\s+/g, ' ').trim()))
    }
  })
}

/** A stretch of the recording to learn the speaker's voice from, with what is said in it. */
export interface VoiceReference {
  startMs: number
  endMs: number
  text: string
}

/**
 * Picks the voice reference from the transcript: the first few seconds of
 * speech, ending at a sentence or a pause when one falls in range — a
 * reference cut mid-phrase makes the cloned voice stumble on what it says
 * next. Its text always ends in punctuation, for the same reason. `null`
 * when the recording has too little speech to learn a voice from.
 */
export function pickVoiceReference(words: readonly TranscriptWord[]): VoiceReference | null {
  const { minMs, maxMs } = DUB_CONFIG.reference
  const first = words[0]
  if (!first) return null

  /** Where the word stops being spoken: the recognizer stretches a word over the pause after it. */
  const spokenEndMs = (word: TranscriptWord): number =>
    Math.min(word.endMs, word.startMs + DUB_CONFIG.referencePauseWordMs)

  let end = -1
  let preferred = -1
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (!word || spokenEndMs(word) - first.startMs > maxMs) break
    end = index
    const pauseFollows = word.endMs - word.startMs >= DUB_CONFIG.referencePauseWordMs
    if (spokenEndMs(word) - first.startMs >= minMs && (ENDS_SENTENCE.test(word.text) || pauseFollows)) {
      preferred = index
    }
  }
  const lastIndex = preferred >= 0 ? preferred : end
  const last = words[lastIndex]
  if (!last || spokenEndMs(last) - first.startMs < minMs) return null

  const text = join(words.slice(0, lastIndex + 1).map((word) => word.text)).replace(/[,;:\s]+$/, '')
  return {
    startMs: first.startMs,
    endMs: spokenEndMs(last),
    text: /[.!?…。！？]$/.test(text) ? text : `${text}.`
  }
}

/** Where a synthesized stretch is placed on the track. */
export interface DubClipPlacement {
  id: string
  startMs: number
  durationMs: number
}

/**
 * Places the synthesized stretches on the track. Each starts when its
 * caption does; one that would begin before the previous one is over waits
 * for it, so two stretches are never heard at once. A stretch with no audio
 * is left out, and nothing is placed past the end of the recording.
 */
export function layoutDubClips(
  units: readonly DubUnit[],
  clipDurationsMs: ReadonlyMap<string, number>,
  durationMs: number
): DubClipPlacement[] {
  const placed: DubClipPlacement[] = []
  let busyUntilMs = 0
  for (const unit of units) {
    const clipMs = clipDurationsMs.get(unit.id)
    if (clipMs === undefined || clipMs <= 0) continue
    const startMs = Math.max(unit.startMs, busyUntilMs)
    if (startMs >= durationMs) break
    placed.push({ id: unit.id, startMs, durationMs: clipMs })
    busyUntilMs = startMs + clipMs + DUB_CONFIG.gapAfterOverrunMs
  }
  return placed
}
