import type { AppError, AppErrorCode } from '@shared/models/errors'
import { appError } from '@shared/models/errors'

/**
 * TypeScript mirror of the helper's JSON-lines protocol
 * (native/macos/CaptureHelper/Sources/CaptureCore/WireProtocol.swift).
 */
export const HELPER_PROTOCOL_VERSION = 2

export type HelperMethod =
  | 'hello'
  | 'permissions.status'
  | 'permissions.requestScreenRecording'
  | 'permissions.requestMedia'
  | 'devices.list'
  | 'sources.list'
  | 'recording.start'
  | 'recording.pause'
  | 'recording.resume'
  | 'recording.stop'

export type HelperErrorCode =
  | 'invalid-request'
  | 'unknown-method'
  | 'invalid-state'
  | 'permission-denied'
  | 'source-unavailable'
  | 'output-unavailable'
  | 'capture-failed'
  | 'no-frames'
  | 'disk-full'
  | 'writer-failed'
  | 'stopped-by-system'
  | 'microphone-permission-denied'
  | 'camera-permission-denied'
  | 'device-unavailable'

export interface HelperErrorPayload {
  code: string
  message: string
}

export interface HelperResponse {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: HelperErrorPayload
}

export interface HelperEvent {
  type: 'event'
  name: string
  payload: unknown
}

export interface HelperLog {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  data?: Record<string, string>
}

export type HelperMessage = HelperResponse | HelperEvent | HelperLog

export interface HelloResult {
  protocolVersion: number
  osVersion: string
}

export type HelperMediaAccess = 'granted' | 'denied' | 'undetermined'

export interface HelperDevice {
  id: string
  name: string
  isDefault: boolean
}

export interface HelperDevicesResult {
  microphones: HelperDevice[]
  cameras: HelperDevice[]
}

export interface HelperTrackResult {
  durationMs: number
  fileSizeBytes: number
  widthPx?: number
  heightPx?: number
}

export interface HelperPermissionsResult {
  screenRecording: boolean
  microphone: HelperMediaAccess
  camera: HelperMediaAccess
  /** Executable macOS attributes the helper's permissions to; absent when unknown. */
  responsibleExecutable?: string
}

export interface HelperDisplayInfo {
  displayId: number
  name: string
  isMain: boolean
  widthPx: number
  heightPx: number
  scaleFactor: number
  thumbnailDataUrl?: string
}

export interface HelperWindowInfo {
  windowId: number
  title: string
  appName: string
  bundleId: string
  displayId?: number
  widthPx: number
  heightPx: number
  thumbnailDataUrl?: string
}

export interface HelperSourcesResult {
  displays: HelperDisplayInfo[]
  windows: HelperWindowInfo[]
}

export type HelperSourceSelector =
  | { kind: 'display'; displayId: number }
  | { kind: 'window'; windowId: number }

export interface HelperStartParams {
  outputPath: string
  source: HelperSourceSelector
  excludePids: number[]
  fps: number
  showCursor: boolean
  telemetry?: { cursorPath: string; interactionsPath: string; sampleRateHz: number }
  microphone?: { deviceId: string; outputPath: string }
  systemAudio?: { outputPath: string }
  webcam?: { deviceId: string; outputPath: string; fps: number }
}

export interface HelperStartResult {
  widthPx: number
  heightPx: number
  fps: number
  videoBitrate: number
  excludedPids: number[]
}

export interface HelperTimeMark {
  recordingTimeMs: number
}

export interface HelperStopResult {
  outputPath: string
  durationMs: number
  mediaDurationMs: number
  fileSizeBytes: number
  widthPx: number
  heightPx: number
  framesWritten: number
  framesDropped: number
  pauses: Array<{ atMs: number; pausedForMs: number }>
  telemetry?: { cursorSamples: number; interactions: number }
  microphone?: HelperTrackResult
  systemAudio?: HelperTrackResult
  webcam?: HelperTrackResult
}

export interface HelperInterruptedPayload {
  error: HelperErrorPayload
  result?: HelperStopResult
}

export const HELPER_EVENT_INTERRUPTED = 'recording.interrupted'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseHelperMessage(value: unknown): HelperMessage | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'response':
      return typeof value.id === 'string' && typeof value.ok === 'boolean'
        ? (value as unknown as HelperResponse)
        : null
    case 'event':
      return typeof value.name === 'string' ? (value as unknown as HelperEvent) : null
    case 'log':
      return typeof value.message === 'string' && typeof value.scope === 'string'
        ? (value as unknown as HelperLog)
        : null
    default:
      return null
  }
}

const ERROR_CODE_MAP: Record<HelperErrorCode, AppErrorCode> = {
  'invalid-request': 'unknown',
  'unknown-method': 'unknown',
  'invalid-state': 'invalid-state',
  'permission-denied': 'screen-recording-permission-denied',
  'source-unavailable': 'source-unavailable',
  'output-unavailable': 'storage-unavailable',
  'capture-failed': 'capture-failed',
  'no-frames': 'recording-invalid',
  'disk-full': 'disk-full',
  'writer-failed': 'capture-failed',
  'stopped-by-system': 'capture-stopped-by-system',
  'microphone-permission-denied': 'microphone-permission-denied',
  'camera-permission-denied': 'camera-permission-denied',
  'device-unavailable': 'device-unavailable'
}

/** Translates a helper failure into the app's user-facing error vocabulary. */
export function toAppError(error: HelperErrorPayload): AppError {
  const code = (ERROR_CODE_MAP as Record<string, AppErrorCode | undefined>)[error.code] ?? 'unknown'
  return appError(code, `${error.code}: ${error.message}`)
}
