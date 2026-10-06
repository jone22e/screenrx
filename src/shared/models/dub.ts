import type { CaptionLanguage } from './project'
import { CAPTION_LANGUAGES } from './project'

/**
 * Dubbing: the captions of a recording, spoken in another language with the
 * speaker's own voice. The voice is cloned on this machine from a few
 * seconds of the microphone track; the result is one more audio track of
 * the session, derived data that can be generated again at any time.
 */

/** Where dubbing stands on this machine. */
export interface DubStatus {
  /** Whether this build can dub at all (the voice helper exists for this platform). */
  available: boolean
  /** The voice model: not yet downloaded, being downloaded, or ready. */
  model: 'missing' | 'preparing' | 'ready'
  /** What the model download weighs, for telling the user before they start it. */
  modelDownloadBytes: number
}

/** The download of the voice model, once, from inside the app. */
export const VOICE_MODEL_DOWNLOAD_BYTES = 1_143_000_000

/** One stretch of speech to synthesize, on the recording's clock. */
export interface DubUnitRequest {
  id: string
  startMs: number
  slotEndMs: number
  text: string
}

export interface DubRequest {
  language: CaptionLanguage
  units: DubUnitRequest[]
  /** The stretch of the microphone track the voice is learned from, and what is said in it. */
  reference: { startMs: number; endMs: number; text: string }
}

export type DubStage = 'downloading' | 'unpacking' | 'loading' | 'synthesizing' | 'verifying' | 'assembling'

export interface DubProgress {
  stage: DubStage
  /** 0…1 within the stage. */
  fraction: number
}

/** A finished dubbing track. */
export interface DubTrack {
  language: CaptionLanguage
  url: string
}

const MAX_UNITS = 2_000
const MAX_TEXT_LENGTH = 2_000
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function isCaptionLanguage(value: unknown): value is CaptionLanguage {
  return (CAPTION_LANGUAGES as readonly unknown[]).includes(value)
}

/** A dubbing request as it arrives from a renderer; `null` when it is not well-formed. */
export function parseDubRequest(value: unknown): DubRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { language, units, reference } = value as Record<string, unknown>
  if (!isCaptionLanguage(language)) return null
  if (!Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS) return null
  if (typeof reference !== 'object' || reference === null) return null

  const { startMs, endMs, text } = reference as Record<string, unknown>
  if (!isTime(startMs) || !isTime(endMs) || endMs <= startMs || typeof text !== 'string' || text.trim() === '') {
    return null
  }

  const clean: DubUnitRequest[] = []
  for (const entry of units) {
    if (typeof entry !== 'object' || entry === null) return null
    const unit = entry as Record<string, unknown>
    if (typeof unit.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(unit.id)) return null
    if (!isTime(unit.startMs) || !isTime(unit.slotEndMs) || unit.slotEndMs < unit.startMs) return null
    if (typeof unit.text !== 'string' || unit.text.trim() === '') return null
    clean.push({
      id: unit.id,
      startMs: unit.startMs,
      slotEndMs: unit.slotEndMs,
      text: unit.text.slice(0, MAX_TEXT_LENGTH)
    })
  }
  if (new Set(clean.map((unit) => unit.id)).size !== clean.length) return null
  return { language, units: clean, reference: { startMs, endMs, text: text.slice(0, MAX_TEXT_LENGTH) } }
}
