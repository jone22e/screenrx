import type { AppError } from './errors'

export const SESSION_SCHEMA_VERSION = 1

/** `recording-YYYYMMDD-HHMMSS-mmm`, generated only by the main process. */
const SESSION_ID_PATTERN = /^recording-\d{8}-\d{6}-\d{3}$/

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

export function createSessionId(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `recording-${day}-${time}-${pad(date.getMilliseconds(), 3)}`
}

export type SessionStatus = 'recording' | 'completed' | 'failed'

/** Longest name a recording can be given. */
export const SESSION_TITLE_MAX_LENGTH = 120

/**
 * The name a recording is given by the user, tidied: trimmed, inner
 * whitespace collapsed, cut to the maximum length. `null` when nothing is
 * left, which means "back to the source's label".
 */
export function normalizeSessionTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX_LENGTH).trim()
  return title.length > 0 ? title : null
}

export interface SessionSource {
  /** `file`: a video recorded elsewhere and imported into the library. */
  kind: 'display' | 'window' | 'file'
  /** Human readable, e.g. "Display 1", "Google Chrome — Docs" or the imported file's name. */
  label: string
  displayId: number | null
  windowId: number | null
  appName: string | null
}

/** A media track of the session; `file` is relative to the session directory. */
export interface VideoAsset {
  file: string
  sizeBytes: number
  /** Duration read back from the file. */
  durationMs: number
  widthPx: number
  heightPx: number
  frameCount: number
  droppedFrameCount: number
}

export interface AudioAsset {
  file: string
  sizeBytes: number
  durationMs: number
  /** Device the track was recorded from; absent for system audio. */
  deviceName?: string
}

export interface WebcamAsset {
  file: string
  sizeBytes: number
  durationMs: number
  widthPx: number
  heightPx: number
  deviceName: string
}

/** A telemetry file of the session; `file` is relative to the session directory. */
export interface TelemetryAsset {
  file: string
  entryCount: number
}

export interface SessionPause {
  /** Recording time at which the pause happened. */
  atMs: number
  /** Wall time spent paused; not part of any track. */
  pausedForMs: number
}

export interface SessionDiagnostic {
  level: 'info' | 'warning'
  code:
    | 'duration-drift'
    | 'frames-dropped'
    | 'interrupted'
    | 'self-exclusion-missing'
    | 'telemetry-missing'
    | 'track-missing'
  message: string
}

/**
 * `session.json`: what was recorded and how. Written when the recording
 * starts (status `recording`) and finalized once when it ends. Media and
 * telemetry files are immutable afterwards; all edits live in the project.
 */
export interface RecordingSessionManifest {
  schemaVersion: typeof SESSION_SCHEMA_VERSION
  id: string
  createdAt: string
  status: SessionStatus
  source: SessionSource
  /** Name given by the user; absent until the recording is renamed. */
  title?: string
  /** When the recording was last exported; absent until it is. */
  lastExportAt?: string
  /** The start of what was said, kept once transcribed, for searching and for suggesting a name. */
  transcriptPreview?: string
  capture: {
    fps: number
    cursorInVideo: boolean
  }
  /** Session timeline according to the shared recording clock. */
  clock: {
    durationMs: number
    pauses: SessionPause[]
  }
  /** Tracks present in the session; each one is a separate file. */
  assets: {
    screen?: VideoAsset
    microphone?: AudioAsset
    systemAudio?: AudioAsset
    webcam?: WebcamAsset
    cursor?: TelemetryAsset
    interactions?: TelemetryAsset
  }
  diagnostics: SessionDiagnostic[]
  failure?: AppError
}

/** What the library screen needs to list a recording. */
/** How far a recording has come, for the label on it: the furthest step wins. */
export type RecordingProgress = 'new' | 'imported' | 'edited' | 'captioned' | 'exported'

export interface RecordingSummary {
  id: string
  createdAt: string
  status: SessionStatus
  progress: RecordingProgress
  /** A name worth giving a recording that still has the source's label, from what was said. */
  suggestedTitle: string | null
  /** The start of what was said, when transcribed; searched along with the title. */
  transcriptPreview: string | null
  /** What the recording is called: the user's name for it, or the source's label. */
  title: string
  sourceLabel: string
  durationMs: number
  /** Every track of the session together. */
  sizeBytes: number
  /** Size of the screen track, `null` when the session has none. */
  resolution: { widthPx: number; heightPx: number } | null
  hasMicrophone: boolean
  hasSystemAudio: boolean
  hasWebcam: boolean
  hasWarnings: boolean
  /** A poster frame, `null` when there is no video to take it from. */
  thumbnailUrl: string | null
}
