import type { CaptionLocaleId, TranscriptWord } from '@shared/models/captions'
import { CAPTION_LOCALES, isCaptionLocale } from '@shared/models/captions'

/**
 * What a Whisper-style transcription service answers (`verbose_json` of the
 * OpenAI audio API, which OpenAI, Groq and the self-hosted servers share), and
 * how it becomes the editor's words.
 */

export interface VerboseWord {
  word: string
  /** Seconds. */
  start: number
  end: number
}

export interface VerboseSegment {
  start: number
  end: number
  text: string
}

export interface VerboseTranscription {
  /** The language heard: an ISO 639-1 code or, from OpenAI, its English name. */
  language: string | null
  words: VerboseWord[]
  segments: VerboseSegment[]
}

const seconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/** A clean transcription from the service's JSON; `null` when it is not one. */
export function parseVerboseTranscription(value: unknown): VerboseTranscription | null {
  if (typeof value !== 'object' || value === null) return null
  const { language, words, segments } = value as Record<string, unknown>
  const result: VerboseTranscription = { language: typeof language === 'string' ? language : null, words: [], segments: [] }
  if (words !== undefined) {
    if (!Array.isArray(words)) return null
    for (const entry of words) {
      if (typeof entry !== 'object' || entry === null) return null
      const { word, start, end } = entry as Record<string, unknown>
      const from = seconds(start)
      const to = seconds(end)
      if (typeof word !== 'string' || from === null || to === null) return null
      result.words.push({ word, start: from, end: Math.max(from, to) })
    }
  }
  if (segments !== undefined) {
    if (!Array.isArray(segments)) return null
    for (const entry of segments) {
      if (typeof entry !== 'object' || entry === null) return null
      const { start, end, text } = entry as Record<string, unknown>
      const from = seconds(start)
      const to = seconds(end)
      if (typeof text !== 'string' || from === null || to === null) return null
      result.segments.push({ start: from, end: Math.max(from, to), text })
    }
  }
  return result
}

const TRAILING_PUNCTUATION = /[\p{P}\p{S}]+$/u
const LEADING_PUNCTUATION = /^[\p{P}\p{S}]+/u

const bare = (text: string): string => text.replace(LEADING_PUNCTUATION, '').replace(TRAILING_PUNCTUATION, '').toLowerCase()

/**
 * The transcription's words, `offsetMs` later. Some services strip the
 * punctuation from the timed words and keep it only in the segments' text;
 * when a segment's text has one token per word, the words take the segment's
 * spelling, so captions end at sentence ends.
 */
export function wordsFromTranscription(transcription: VerboseTranscription, offsetMs = 0): TranscriptWord[] {
  const words = transcription.words.map((word) => ({ text: word.word.trim(), startMs: word.start * 1000 + offsetMs, endMs: word.end * 1000 + offsetMs }))
  if (words.length === 0) {
    // No word timings: each segment is one "word" spanning its time; the captions stay readable.
    return transcription.segments
      .filter((segment) => segment.text.trim() !== '')
      .map((segment) => ({ text: segment.text.trim(), startMs: segment.start * 1000 + offsetMs, endMs: segment.end * 1000 + offsetMs }))
  }
  let next = 0
  for (const segment of transcription.segments) {
    const tokens = segment.text.split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0) continue
    const first = next
    const last = first + tokens.length
    if (last > words.length) break
    const sameWords = tokens.every((token, index) => bare(token) === bare(words[first + index]?.text ?? ''))
    if (!sameWords) continue
    for (let index = 0; index < tokens.length; index++) (words[first + index] as TranscriptWord).text = tokens[index] as string
    next = last
  }
  return words.filter((word) => word.text !== '')
}

/** The ISO 639-1 language the services take, from the editor's locale. */
export function whisperLanguageOf(locale: CaptionLocaleId): string {
  return locale.slice(0, 2)
}

/** The language names OpenAI answers with, by code. */
const LANGUAGE_NAMES: Record<string, string> = {
  portuguese: 'pt',
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh'
}

/** The locale offered in the editor for a language the service heard, or `null` when none is. */
export function captionLocaleOfLanguage(language: string): CaptionLocaleId | null {
  const lower = language.trim().toLowerCase()
  if (isCaptionLocale(language)) return language
  const code = LANGUAGE_NAMES[lower] ?? lower.slice(0, 2)
  return CAPTION_LOCALES.find((locale) => locale.id.startsWith(`${code}-`))?.id ?? null
}
