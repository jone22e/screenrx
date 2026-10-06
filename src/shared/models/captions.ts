/**
 * Speech-to-text of a recording's audio. A transcript is derived data: it is
 * computed from an audio track, stored next to it as `transcript.json`, and
 * can be regenerated at any time. Captions are built from it.
 */

/** One recognized word and the stretch of the recording (source time) where it is spoken. */
export interface TranscriptWord {
  text: string
  startMs: number
  endMs: number
}

export type TranscriptTrack = 'microphone' | 'systemAudio'

export const TRANSCRIPT_SCHEMA_VERSION = 1

export interface Transcript {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION
  /** BCP 47 id of the language that was recognized. */
  locale: string
  /** The audio track the words come from. */
  track: TranscriptTrack
  words: TranscriptWord[]
}

/** Languages offered for transcription, in the order they are listed. */
export const CAPTION_LOCALES = [
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'pt-PT', label: 'Português (Portugal)' },
  { id: 'en-US', label: 'Inglês (EUA)' },
  { id: 'en-GB', label: 'Inglês (Reino Unido)' },
  { id: 'es-ES', label: 'Espanhol (Espanha)' },
  { id: 'es-MX', label: 'Espanhol (México)' },
  { id: 'fr-FR', label: 'Francês' },
  { id: 'de-DE', label: 'Alemão' },
  { id: 'it-IT', label: 'Italiano' },
  { id: 'ja-JP', label: 'Japonês' },
  { id: 'ko-KR', label: 'Coreano' },
  { id: 'zh-CN', label: 'Chinês (simplificado)' }
] as const

export type CaptionLocaleId = (typeof CAPTION_LOCALES)[number]['id']

export const DEFAULT_CAPTION_LOCALE: CaptionLocaleId = 'pt-BR'

export function isCaptionLocale(value: unknown): value is CaptionLocaleId {
  return CAPTION_LOCALES.some((locale) => locale.id === value)
}

export function isTranscriptTrack(value: unknown): value is TranscriptTrack {
  return value === 'microphone' || value === 'systemAudio'
}

/** What to transcribe: which track of the session, in which language. */
export interface TranscriptionRequest {
  locale: CaptionLocaleId
  track: TranscriptTrack
}

export function parseTranscriptionRequest(value: unknown): TranscriptionRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { locale, track } = value as Record<string, unknown>
  return isCaptionLocale(locale) && isTranscriptTrack(track) ? { locale, track } : null
}

/** What is asked to be translated: captions (id and text), from which language, into which. */
export interface CaptionTranslationRequest {
  language: 'en' | 'es' | 'zh' | 'pt'
  sourceLocale: string
  cues: Array<{ id: string; text: string }>
}

const MAX_TRANSLATED_CUES = 20_000
const MAX_CUE_TEXT_LENGTH = 300
const MAX_CUE_ID_LENGTH = 64

export function parseCaptionTranslationRequest(value: unknown): CaptionTranslationRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { language, sourceLocale, cues } = value as Record<string, unknown>
  if (language !== 'en' && language !== 'es' && language !== 'zh' && language !== 'pt') return null
  if (typeof sourceLocale !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(sourceLocale)) return null
  if (!Array.isArray(cues) || cues.length === 0 || cues.length > MAX_TRANSLATED_CUES) return null
  const clean: CaptionTranslationRequest['cues'] = []
  for (const entry of cues) {
    if (typeof entry !== 'object' || entry === null) return null
    const { id, text } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || id.length > MAX_CUE_ID_LENGTH || typeof text !== 'string') return null
    clean.push({ id, text: text.slice(0, MAX_CUE_TEXT_LENGTH) })
  }
  return { language, sourceLocale, cues: clean }
}

export type TranscriptionStage = 'preparing' | 'downloading' | 'transcribing'

export interface TranscriptionProgress {
  sessionId: string
  stage: TranscriptionStage
  /** How much of the track has been transcribed, 0…1. */
  fraction: number
}

const MAX_WORDS = 500_000
const MAX_WORD_LENGTH = 200

/** A word as it arrives from the recognizer or from disk; `null` when it is not one. */
export function parseTranscriptWord(value: unknown): TranscriptWord | null {
  if (typeof value !== 'object' || value === null) return null
  const { text, startMs, endMs } = value as Record<string, unknown>
  if (typeof text !== 'string' || text.length > MAX_WORD_LENGTH) return null
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return null
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) return null
  return { text, startMs, endMs }
}

/** Returns a clean `Transcript`, or `null` when the value is not one. */
export function parseTranscript(value: unknown): Transcript | null {
  if (typeof value !== 'object' || value === null) return null
  const { schemaVersion, locale, track, words } = value as Record<string, unknown>
  if (schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) return null
  if (typeof locale !== 'string' || locale.length > 35 || !isTranscriptTrack(track)) return null
  if (!Array.isArray(words) || words.length > MAX_WORDS) return null
  const parsed: TranscriptWord[] = []
  for (const entry of words) {
    const word = parseTranscriptWord(entry)
    if (!word) return null
    parsed.push(word)
  }
  return { schemaVersion: TRANSCRIPT_SCHEMA_VERSION, locale, track, words: parsed }
}
