import type { AudioTrackKind, CaptionLanguage, CaptionLength, FrameAspect, FrameFit } from './project'
import { AUDIO_TRACK_KINDS, CAPTION_LANGUAGES } from './project'

/**
 * The editing assistant: a conversation with the AI tool in use, which answers
 * questions about the recording and asks the editor for edits. Only text goes
 * to the AI — the transcript, a description of the edit, the conversation.
 */

export interface AssistantMessage {
  role: 'user' | 'assistant'
  text: string
}

/** A stretch of the recording, on its own clock. */
export interface AssistantSpan {
  startMs: number
  endMs: number
}

/** What the editor looks like now, told to the AI so it answers about the real state. */
export interface AssistantEditState {
  durationMs: number
  cuts: AssistantSpan[]
  zooms: Array<AssistantSpan & { scale: number }>
  speed: number
  hasCaptions: boolean
  captionsVisible: boolean
  captionLanguage: CaptionLanguage | null
  captionLength: CaptionLength
  backgroundId: string | null
  hasWebcam: boolean
  webcamVisible: boolean
  hasSystemAudio: boolean
  microphoneMuted: boolean
  systemAudioMuted: boolean
}

export interface AssistantRequest {
  message: string
  /** The conversation so far, oldest first; the new message is not in it. */
  history: AssistantMessage[]
  edit: AssistantEditState
}

/** An edit the AI asked for, already on the recording's clock and checked. */
export type AssistantAction =
  | { type: 'cut'; startMs: number; endMs: number }
  | { type: 'uncut'; startMs: number; endMs: number }
  | { type: 'zoom'; startMs: number; endMs: number; scale: number | null }
  | { type: 'remove-zoom'; startMs: number; endMs: number }
  | { type: 'speed'; speed: number }
  | { type: 'captions'; visible: boolean }
  | { type: 'caption-language'; language: CaptionLanguage | null }
  | { type: 'caption-length'; length: CaptionLength }
  | { type: 'background'; presetId: string | null }
  | { type: 'format'; aspect: FrameAspect }
  | { type: 'framing'; fit: FrameFit }
  | { type: 'webcam'; visible: boolean }
  | { type: 'mute'; track: AudioTrackKind; muted: boolean }
  | { type: 'text'; text: string; startMs: number; endMs: number }

export interface AssistantReply {
  text: string
  actions: AssistantAction[]
}

export const ASSISTANT_LIMITS = {
  maxMessageLength: 2000,
  /** Older messages are left out of what the AI sees. */
  historyMessages: 12
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function parseSpan(value: unknown): AssistantSpan | null {
  if (!isRecord(value) || !isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) return null
  return { startMs: value.startMs, endMs: value.endMs }
}

/** Validates what a renderer sent; `null` when it is not a request. */
export function parseAssistantRequest(value: unknown): AssistantRequest | null {
  if (!isRecord(value) || typeof value.message !== 'string' || !isRecord(value.edit)) return null
  const message = value.message.trim().slice(0, ASSISTANT_LIMITS.maxMessageLength)
  if (message === '') return null
  const history: AssistantMessage[] = []
  for (const entry of Array.isArray(value.history) ? value.history : []) {
    if (!isRecord(entry) || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string') continue
    history.push({ role: entry.role, text: entry.text.slice(0, ASSISTANT_LIMITS.maxMessageLength) })
  }
  const edit = value.edit
  if (!isFiniteNumber(edit.durationMs) || !isFiniteNumber(edit.speed)) return null
  const cuts = (Array.isArray(edit.cuts) ? edit.cuts : []).map(parseSpan).filter((span): span is AssistantSpan => span !== null)
  const zooms = (Array.isArray(edit.zooms) ? edit.zooms : [])
    .map((zoom) => {
      const span = parseSpan(zoom)
      return span && isRecord(zoom) && isFiniteNumber(zoom.scale) ? { ...span, scale: zoom.scale } : null
    })
    .filter((zoom): zoom is AssistantSpan & { scale: number } => zoom !== null)
  const language = (CAPTION_LANGUAGES as readonly unknown[]).includes(edit.captionLanguage)
    ? (edit.captionLanguage as CaptionLanguage)
    : null
  const length = edit.captionLength === 'short' || edit.captionLength === 'long' ? edit.captionLength : 'medium'
  return {
    message,
    history: history.slice(-ASSISTANT_LIMITS.historyMessages),
    edit: {
      durationMs: edit.durationMs,
      cuts,
      zooms,
      speed: edit.speed,
      hasCaptions: edit.hasCaptions === true,
      captionsVisible: edit.captionsVisible === true,
      captionLanguage: language,
      captionLength: length,
      backgroundId: typeof edit.backgroundId === 'string' ? edit.backgroundId : null,
      hasWebcam: edit.hasWebcam === true,
      webcamVisible: edit.webcamVisible === true,
      hasSystemAudio: edit.hasSystemAudio === true,
      microphoneMuted: edit.microphoneMuted === true,
      systemAudioMuted: edit.systemAudioMuted === true
    }
  }
}

export const isAudioTrackKind = (value: unknown): value is AudioTrackKind =>
  (AUDIO_TRACK_KINDS as readonly unknown[]).includes(value)
