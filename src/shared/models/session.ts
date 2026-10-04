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

export interface SessionSource {
  kind: 'display' | 'window'
  /** Human readable, e.g. "Display 1" or "Google Chrome — Docs". */
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
export interface RecordingSummary {
  id: string
  createdAt: string
  status: SessionStatus
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
