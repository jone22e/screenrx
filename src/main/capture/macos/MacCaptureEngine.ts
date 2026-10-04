import type { Unsubscribe } from '@shared/ipc/contract'
import type { CaptureSourceCatalog } from '@shared/models/capture'
import { displaySourceId, windowSourceId } from '@shared/models/capture'
import { appError } from '@shared/models/errors'
import type { CaptureDevices } from '@shared/models/devices'
import type { MediaPermissionKind, PermissionReport } from '@shared/models/permissions'
import type { Logger } from '../../logging/logger'
import type {
  CaptureEngine,
  CaptureInterruption,
  CaptureResult,
  CaptureStartInfo,
  CaptureTimeMark,
  CaptureTrack,
  ListSourcesOptions,
  StartCaptureRequest
} from '../CaptureEngine'
import { CaptureError } from '../CaptureEngine'
import type { HelperProcess } from './HelperProcess'
import { HelperExitedError, HelperRequestError, HelperTimeoutError } from './HelperProcess'
import { granteeOf } from './grantee'
import type {
  HelloResult,
  HelperDevicesResult,
  HelperInterruptedPayload,
  HelperMediaAccess,
  HelperMethod,
  HelperPermissionsResult,
  HelperSourceSelector,
  HelperSourcesResult,
  HelperStartParams,
  HelperStartResult,
  HelperStopResult,
  HelperTimeMark,
  HelperTrackResult
} from './helperProtocol'
import { HELPER_EVENT_INTERRUPTED, HELPER_PROTOCOL_VERSION, toAppError } from './helperProtocol'

const TIMEOUTS_MS = {
  default: 10_000,
  listSources: 20_000,
  start: 15_000,
  /** Finalizing a long recording can take a while. */
  stop: 60_000,
  /** A system permission prompt waits for the user. */
  permissionPrompt: 120_000
} as const

/** macOS capture engine: ScreenCaptureKit, driven through the native helper. */
export class MacCaptureEngine implements CaptureEngine {
  private readonly interruptionListeners = new Set<(interruption: CaptureInterruption) => void>()
  private handshake: { generation: number; verified: Promise<void> } | null = null
  private screenRecordingGranted: boolean | null = null
  private permissionCheck: Promise<PermissionReport> | null = null
  private callsInFlight = 0
  private capturing = false

  constructor(
    private readonly helper: HelperProcess,
    private readonly logger: Logger
  ) {
    helper.onEvent((name, payload) => {
      if (name !== HELPER_EVENT_INTERRUPTED) return
      const interruption = payload as HelperInterruptedPayload
      this.capturing = false
      this.emitInterruption({
        error: toAppError(interruption.error),
        result: interruption.result ? toCaptureResult(interruption.result) : null
      })
    })
    helper.onExit((expected) => {
      if (expected || !this.capturing) return
      this.capturing = false
      this.emitInterruption({ error: appError('capture-helper-exited'), result: null })
    })
  }

  getPermissions(): Promise<PermissionReport> {
    // Several windows ask at once (and again on every focus); they share one check.
    this.permissionCheck ??= this.checkPermissions().finally(() => {
      this.permissionCheck = null
    })
    return this.permissionCheck
  }

  private async checkPermissions(): Promise<PermissionReport> {
    // macOS caches the grant per process: a helper that started without the
    // permission keeps reporting "denied" until it is respawned. Respawning
    // would abort requests in flight, so it only happens when the helper is idle.
    const stale = this.screenRecordingGranted === false
    if (stale && !this.capturing && this.callsInFlight === 0) {
      await this.helper.dispose()
    }
    const result = await this.call<HelperPermissionsResult>('permissions.status')
    return this.rememberPermissions(result)
  }

  async requestScreenRecordingPermission(): Promise<PermissionReport> {
    const result = await this.call<HelperPermissionsResult>('permissions.requestScreenRecording')
    return this.rememberPermissions(result)
  }

  async requestMediaPermission(kind: MediaPermissionKind): Promise<PermissionReport> {
    // The user may take a while to answer the system prompt.
    const result = await this.call<HelperPermissionsResult>(
      'permissions.requestMedia',
      { kind },
      TIMEOUTS_MS.permissionPrompt
    )
    return this.rememberPermissions(result)
  }

  listDevices(): Promise<CaptureDevices> {
    return this.call<HelperDevicesResult>('devices.list')
  }

  async listSources(options: ListSourcesOptions): Promise<CaptureSourceCatalog> {
    const result = await this.call<HelperSourcesResult>(
      'sources.list',
      {
        excludePids: options.excludePids,
        includeWindows: options.includeWindows,
        thumbnailMaxWidth: options.thumbnailMaxWidthPx
      },
      TIMEOUTS_MS.listSources
    )
    return {
      displays: result.displays.map((display, position) => ({
        kind: 'display',
        id: displaySourceId(display.displayId),
        displayId: display.displayId,
        index: position + 1,
        name: display.name,
        isMain: display.isMain,
        widthPx: display.widthPx,
        heightPx: display.heightPx,
        scaleFactor: display.scaleFactor,
        thumbnailDataUrl: display.thumbnailDataUrl ?? null
      })),
      windows: result.windows.map((window) => ({
        kind: 'window',
        id: windowSourceId(window.windowId),
        windowId: window.windowId,
        title: window.title,
        appName: window.appName,
        bundleId: window.bundleId,
        displayId: window.displayId ?? null,
        widthPx: window.widthPx,
        heightPx: window.heightPx,
        thumbnailDataUrl: window.thumbnailDataUrl ?? null
      }))
    }
  }

  async start(request: StartCaptureRequest): Promise<CaptureStartInfo> {
    const source: HelperSourceSelector =
      request.source.kind === 'display'
        ? { kind: 'display', displayId: request.source.displayId }
        : { kind: 'window', windowId: request.source.windowId }
    const params: HelperStartParams = {
      outputPath: request.outputPath,
      source,
      excludePids: request.excludePids,
      fps: request.fps,
      showCursor: request.showCursor,
      ...(request.telemetry && { telemetry: request.telemetry }),
      ...(request.microphone && { microphone: request.microphone }),
      ...(request.systemAudio && { systemAudio: request.systemAudio }),
      ...(request.webcam && { webcam: request.webcam })
    }
    const result = await this.call<HelperStartResult>('recording.start', params, TIMEOUTS_MS.start)
    this.capturing = true
    return {
      widthPx: result.widthPx,
      heightPx: result.heightPx,
      fps: result.fps,
      excludedPids: result.excludedPids
    }
  }

  pause(): Promise<CaptureTimeMark> {
    return this.call<HelperTimeMark>('recording.pause')
  }

  resume(): Promise<CaptureTimeMark> {
    return this.call<HelperTimeMark>('recording.resume')
  }

  async stop(): Promise<CaptureResult> {
    try {
      return toCaptureResult(
        await this.call<HelperStopResult>('recording.stop', undefined, TIMEOUTS_MS.stop)
      )
    } finally {
      this.capturing = false
    }
  }

  onInterrupted(listener: (interruption: CaptureInterruption) => void): Unsubscribe {
    this.interruptionListeners.add(listener)
    return () => this.interruptionListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    this.capturing = false
    await this.helper.dispose()
  }

  private rememberPermissions(result: HelperPermissionsResult): PermissionReport {
    this.screenRecordingGranted = result.screenRecording
    return {
      permissions: {
        screenRecording: result.screenRecording ? 'granted' : 'not-granted',
        microphone: toPermissionState(result.microphone),
        camera: toPermissionState(result.camera)
      },
      grantee: granteeOf(result.responsibleExecutable, process.execPath)
    }
  }

  private emitInterruption(interruption: CaptureInterruption): void {
    for (const listener of this.interruptionListeners) listener(interruption)
  }

  private async call<Result>(
    method: HelperMethod,
    params?: unknown,
    timeoutMs: number = TIMEOUTS_MS.default
  ): Promise<Result> {
    this.callsInFlight += 1
    try {
      await this.verifyProtocol()
      return await this.helper.request<Result>(method, params, timeoutMs)
    } catch (error) {
      throw toCaptureError(error)
    } finally {
      this.callsInFlight -= 1
    }
  }

  /**
   * Each freshly spawned helper must speak the protocol version this build
   * expects. Concurrent calls share one handshake per helper process.
   */
  private verifyProtocol(): Promise<void> {
    const current = this.handshake
    if (current && this.helper.isRunning && current.generation === this.helper.generation) {
      return current.verified
    }
    const verified = this.helper
      .request<HelloResult>('hello', undefined, TIMEOUTS_MS.default)
      .then((hello) => {
        if (hello.protocolVersion !== HELPER_PROTOCOL_VERSION) {
          throw new CaptureError(
            appError(
              'capture-helper-unavailable',
              `protocol ${hello.protocolVersion}, expected ${HELPER_PROTOCOL_VERSION}`
            )
          )
        }
        this.logger.info('helper ready', { osVersion: hello.osVersion })
      })
    // `request` has spawned the helper by now, so this is the new generation.
    this.handshake = { generation: this.helper.generation, verified }
    return verified
  }
}

function toCaptureResult(result: HelperStopResult): CaptureResult {
  return {
    outputPath: result.outputPath,
    durationMs: result.durationMs,
    mediaDurationMs: result.mediaDurationMs,
    fileSizeBytes: result.fileSizeBytes,
    widthPx: result.widthPx,
    heightPx: result.heightPx,
    framesWritten: result.framesWritten,
    framesDropped: result.framesDropped,
    pauses: result.pauses,
    telemetry: result.telemetry ?? null,
    microphone: toCaptureTrack(result.microphone),
    systemAudio: toCaptureTrack(result.systemAudio),
    webcam: toCaptureTrack(result.webcam)
  }
}

function toCaptureTrack(track: HelperTrackResult | undefined): CaptureTrack | null {
  if (!track) return null
  return {
    durationMs: track.durationMs,
    fileSizeBytes: track.fileSizeBytes,
    widthPx: track.widthPx ?? null,
    heightPx: track.heightPx ?? null
  }
}

function toPermissionState(access: HelperMediaAccess): 'granted' | 'not-granted' {
  return access === 'granted' ? 'granted' : 'not-granted'
}

function toCaptureError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error
  if (error instanceof HelperRequestError) return new CaptureError(toAppError(error.payload))
  if (error instanceof HelperExitedError) {
    const code = error.kind === 'spawn-failed' ? 'capture-helper-unavailable' : 'capture-helper-exited'
    return new CaptureError(appError(code, error.message))
  }
  if (error instanceof HelperTimeoutError) {
    return new CaptureError(appError('capture-failed', error.message))
  }
  return new CaptureError(appError('unknown', String(error)))
}
