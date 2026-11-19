import type { TranscriptWord } from './captions'
import { parseTranscriptWord } from './captions'
import type { AppErrorCode } from './errors'
import { isAppErrorCode } from './errors'

/**
 * What the web editor and its server say to each other about transcription.
 * The page sends a mono 16-bit WAV at `TRANSCRIPTION_SAMPLE_RATE`; the server
 * answers a stream of JSON lines: progress, then the words or an error.
 */

export const TRANSCRIPTION_API_PATH = '/api/transcription'

/** Whisper listens at 16 kHz; sending more is only more bytes. */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000

/** What the server offers, answered to a GET of the path. */
export interface TranscriptionServiceInfo {
  transcription: boolean
  /** The longest audio accepted, in minutes. */
  maxMinutes: number
}

export function parseTranscriptionServiceInfo(value: unknown): TranscriptionServiceInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const { transcription, maxMinutes } = value as Record<string, unknown>
  if (typeof transcription !== 'boolean') return null
  return { transcription, maxMinutes: typeof maxMinutes === 'number' && maxMinutes > 0 ? maxMinutes : 0 }
}

/** What is asked of a POST: `locale` to transcribe in that language, or `detect` to hear which language it is. */
export type TranscriptionMode = 'transcribe' | 'detect'

export type TranscriptionEvent =
  /** `downloading`: the service is fetching the language model first (a self-hosted one, on its first use). */
  | { type: 'progress'; fraction: number; stage?: 'downloading' | 'transcribing' }
  | { type: 'done'; words: TranscriptWord[]; language: string | null }
  | { type: 'error'; code: AppErrorCode; detail?: string }

export function parseTranscriptionEvent(value: unknown): TranscriptionEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const { type } = value as Record<string, unknown>
  if (type === 'progress') {
    const { fraction, stage } = value as Record<string, unknown>
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null
    const clean = Math.max(0, Math.min(1, fraction))
    return stage === 'downloading' || stage === 'transcribing' ? { type, fraction: clean, stage } : { type, fraction: clean }
  }
  if (type === 'done') {
    const { words, language } = value as Record<string, unknown>
    if (!Array.isArray(words)) return null
    const clean: TranscriptWord[] = []
    for (const entry of words) {
      const word = parseTranscriptWord(entry)
      if (!word) return null
      clean.push(word)
    }
    return { type, words: clean, language: typeof language === 'string' ? language : null }
  }
  if (type === 'error') {
    const { code, detail } = value as Record<string, unknown>
    if (!isAppErrorCode(code)) return null
    return typeof detail === 'string' ? { type, code, detail } : { type, code }
  }
  return null
}
