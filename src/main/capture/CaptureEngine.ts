import type { Unsubscribe } from '@shared/ipc/contract'
import type { CaptureSource, CaptureSourceCatalog } from '@shared/models/capture'
import type { AppError } from '@shared/models/errors'
import type { CaptureDevices } from '@shared/models/devices'
import type { MediaPermissionKind, PermissionReport } from '@shared/models/permissions'
import type { SessionPause } from '@shared/models/session'

export interface ListSourcesOptions {
  /** Processes whose windows are hidden from the list and from thumbnails. */
  excludePids: number[]
  includeWindows: boolean
  /** `null` skips thumbnails (much faster, used for menus). */
  thumbnailMaxWidthPx: number | null
}

export interface StartCaptureRequest {
  /** Absolute path of the screen track to create. Must not exist yet. */
  outputPath: string
  source: CaptureSource
  /** Applications removed from display captures: the recorder's own windows. */
  excludePids: number[]
  fps: number
  showCursor: boolean
  /** Pointer telemetry files to create (they must not exist yet), or `null` to skip it. */
  telemetry: { cursorPath: string; interactionsPath: string; sampleRateHz: number } | null
  /** Companion tracks; each is recorded to its own file, or skipped when `null`. */
  microphone: { deviceId: string; outputPath: string } | null
  systemAudio: { outputPath: string } | null
  webcam: { deviceId: string; outputPath: string; fps: number } | null
}

/** A finished companion track. */
export interface CaptureTrack {
  durationMs: number
  fileSizeBytes: number
  widthPx: number | null
  heightPx: number | null
}

export interface CaptureStartInfo {
  widthPx: number
  heightPx: number
  fps: number
  /** Subset of `excludePids` the engine actually removed from the capture. */
  excludedPids: number[]
}

/** Recording time at which a pause or resume took effect in the media. */
export interface CaptureTimeMark {
  recordingTimeMs: number
}

export interface CaptureResult {
  outputPath: string
  /** Duration according to the engine's recording clock. */
  durationMs: number
  /** Duration read back from the finished file. */
  mediaDurationMs: number
  fileSizeBytes: number
  widthPx: number
  heightPx: number
  framesWritten: number
  framesDropped: number
  pauses: SessionPause[]
  /** Entry counts of the telemetry files; `null` when they were not written. */
  telemetry: { cursorSamples: number; interactions: number } | null
  /** Companion tracks that were requested and ended up with media. */
  microphone: CaptureTrack | null
  systemAudio: CaptureTrack | null
  webcam: CaptureTrack | null
}

/** The capture ended without a stop request. */
export interface CaptureInterruption {
  error: AppError
  /** Present when the file could still be finalized with what was recorded. */
  result: CaptureResult | null
}

/** Failure of a capture operation, already translated for the user. */
export class CaptureError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ? `${appError.code}: ${appError.detail}` : appError.code)
    this.name = 'CaptureError'
  }
}

/**
 * Platform-independent capture contract. Everything above this interface
 * (sessions, HUD, editor, export) is unaware of ScreenCaptureKit; a Windows
 * implementation only has to provide another engine.
 */
export interface CaptureEngine {
  /** Never prompts. */
  getPermissions(): Promise<PermissionReport>
  /** May show the system prompt; call only in response to a user action. */
  requestScreenRecordingPermission(): Promise<PermissionReport>
  /** Shows the system prompt the first time; call only in response to a user action. */
  requestMediaPermission(kind: MediaPermissionKind): Promise<PermissionReport>
  listDevices(): Promise<CaptureDevices>
  listSources(options: ListSourcesOptions): Promise<CaptureSourceCatalog>
  start(request: StartCaptureRequest): Promise<CaptureStartInfo>
  pause(): Promise<CaptureTimeMark>
  resume(): Promise<CaptureTimeMark>
  stop(): Promise<CaptureResult>
  onInterrupted(listener: (interruption: CaptureInterruption) => void): Unsubscribe
  /** Finalizes any recording in progress and releases native resources. */
  dispose(): Promise<void>
}
