import { RECORDING_CONFIG, SESSION_FILES } from '@shared/config/recording'
import type { Unsubscribe } from '@shared/ipc/contract'
import type { CaptureSource } from '@shared/models/capture'
import type { CaptureDevice, RecordingOptions } from '@shared/models/devices'
import { DEFAULT_RECORDING_OPTIONS } from '@shared/models/devices'
import { findSource, isCaptureSourceId, sourceLabel } from '@shared/models/capture'
import type { AppError } from '@shared/models/errors'
import type { MediaPermissionKind } from '@shared/models/permissions'
import { appError } from '@shared/models/errors'
import type { RecordingPhase, RecordingStateSnapshot } from '@shared/models/recording'
import type {
  RecordingSessionManifest,
  SessionDiagnostic,
  SessionSource
} from '@shared/models/session'
import { RecordingClock } from '@shared/time/RecordingClock'
import type { CaptureEngine, CaptureInterruption, CaptureResult } from '../capture/CaptureEngine'
import { CaptureError } from '../capture/CaptureEngine'
import type { Logger } from '../logging/logger'
import type { SessionStore } from './SessionStore'
import { diagnoseCapture, diagnoseMissingTracks, isUsableRecording } from './diagnostics'

/**
 * Keeps the recorder's own UI out of the recording. Engaged right before
 * the capture starts and released once it has ended.
 */
export interface CaptureShield {
  engage(): void
  release(): void
}

export interface RecordingControllerDeps {
  engine: CaptureEngine
  sessions: SessionStore
  shield: CaptureShield
  logger: Logger
  /** Monotonic time source for the recording clock. */
  monotonicNow: () => number
  wallClock: () => Date
  /** Processes owning this app's windows, to be excluded from captures. */
  ownPids: () => number[]
}

interface ActiveRecording {
  manifest: RecordingSessionManifest
  screenPath: string
  clock: RecordingClock
  diagnostics: SessionDiagnostic[]
  /** The companion tracks this recording was started with. */
  options: RecordingOptions
}

/**
 * The recording state machine: idle → starting → recording ⇄ paused →
 * stopping → idle. It owns the session lifecycle and is the single source
 * of truth for every window. Operations are serialized, so a double click
 * or two windows acting at once cannot interleave transitions.
 */
export class RecordingController {
  private phase: RecordingPhase = 'idle'
  private source: CaptureSource | null = null
  private options: RecordingOptions = DEFAULT_RECORDING_OPTIONS
  private active: ActiveRecording | null = null
  private lastError: AppError | null = null
  private lastCompletedSessionId: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly stateListeners = new Set<(state: RecordingStateSnapshot) => void>()
  private readonly libraryListeners = new Set<() => void>()
  private readonly unsubscribeFromEngine: Unsubscribe

  constructor(private readonly deps: RecordingControllerDeps) {
    this.unsubscribeFromEngine = deps.engine.onInterrupted((interruption) => {
      void this.enqueue(() => this.handleInterruption(interruption))
    })
  }

  getState(): RecordingStateSnapshot {
    return {
      phase: this.phase,
      selectedSource: this.source
        ? { id: this.source.id, kind: this.source.kind, label: sourceLabel(this.source) }
        : null,
      options: this.options,
      sessionId: this.active?.manifest.id ?? null,
      elapsedMs: this.active?.clock.currentTimeMs() ?? 0,
      clockRunning: this.active?.clock.isRunning ?? false,
      lastError: this.lastError,
      lastCompletedSessionId: this.lastCompletedSessionId
    }
  }

  onStateChanged(listener: (state: RecordingStateSnapshot) => void): Unsubscribe {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Fires whenever the set of recordings on disk changes. */
  onLibraryChanged(listener: () => void): Unsubscribe {
    this.libraryListeners.add(listener)
    return () => this.libraryListeners.delete(listener)
  }

  selectSource(sourceId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== 'idle' || !isCaptureSourceId(sourceId)) return
      try {
        const catalog = await this.listSourcesForSelection()
        const source = findSource(catalog, sourceId)
        if (!source) throw new CaptureError(appError('source-unavailable', sourceId))
        this.source = source
        this.lastError = null
      } catch (error) {
        this.lastError = toAppError(error)
      }
      this.emit()
    })
  }

  /** Preselects the main display, so recording is one click away. Never prompts. */
  selectDefaultSource(): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== 'idle' || this.source) return
      try {
        this.source = await this.findDefaultSource()
        this.emit()
      } catch (error) {
        this.deps.logger.info('no default source yet', { reason: toAppError(error).code })
      }
    })
  }

  /** Turns the microphone track on (with the given device) or off (`null`). */
  setMicrophone(deviceId: string | null): Promise<void> {
    return this.setDevice('microphone', deviceId, (device) => ({
      microphoneId: device?.id ?? null,
      microphoneName: device?.name ?? null
    }))
  }

  /** Turns the webcam track on (with the given device) or off (`null`). */
  setCamera(deviceId: string | null): Promise<void> {
    return this.setDevice('camera', deviceId, (device) => ({
      cameraId: device?.id ?? null,
      cameraName: device?.name ?? null
    }))
  }

  /** System audio needs no permission of its own: it comes with the screen capture. */
  setSystemAudio(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== 'idle') return
      this.options = { ...this.options, systemAudio: enabled }
      this.emit()
    })
  }

  start(): Promise<void> {
    return this.enqueue(() => this.runStart())
  }

  pause(): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active
      if (this.phase !== 'recording' || !active) return
      try {
        const mark = await this.deps.engine.pause()
        active.clock.pause()
        active.clock.alignTo(mark.recordingTimeMs)
        this.phase = 'paused'
        this.deps.logger.info('paused', { atMs: Math.round(mark.recordingTimeMs) })
      } catch (error) {
        this.lastError = toAppError(error)
        this.deps.logger.error('pause failed', { error: String(error) })
      }
      this.emit()
    })
  }

  resume(): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active
      if (this.phase !== 'paused' || !active) return
      try {
        const mark = await this.deps.engine.resume()
        active.clock.resume()
        active.clock.alignTo(mark.recordingTimeMs)
        this.phase = 'recording'
        this.deps.logger.info('resumed', { atMs: Math.round(mark.recordingTimeMs) })
      } catch (error) {
        this.lastError = toAppError(error)
        this.deps.logger.error('resume failed', { error: String(error) })
      }
      this.emit()
    })
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.runStop())
  }

  dismissError(): void {
    if (!this.lastError) return
    this.lastError = null
    this.emit()
  }

  /** Finalizes a recording in progress; used when the app is quitting. */
  async shutdown(): Promise<void> {
    await this.stop()
    this.unsubscribeFromEngine()
  }

  /**
   * Enabling a device asks for its permission right then — the one moment the
   * user expects the system prompt — so recording never starts with a track
   * that cannot be captured.
   */
  private setDevice(
    kind: MediaPermissionKind,
    deviceId: string | null,
    toOptions: (device: CaptureDevice | null) => Partial<RecordingOptions>
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== 'idle') return
      if (deviceId === null) {
        this.options = { ...this.options, ...toOptions(null) }
        this.emit()
        return
      }
      try {
        const report = await this.deps.engine.requestMediaPermission(kind)
        if (report.permissions[kind] !== 'granted') {
          throw new CaptureError(appError(`${kind}-permission-denied`, report.grantee.name ?? undefined))
        }
        const devices = await this.deps.engine.listDevices()
        const candidates = kind === 'microphone' ? devices.microphones : devices.cameras
        const device = candidates.find((candidate) => candidate.id === deviceId)
        if (!device) throw new CaptureError(appError('device-unavailable', deviceId))
        this.options = { ...this.options, ...toOptions(device) }
        this.lastError = null
      } catch (error) {
        this.lastError = toAppError(error)
        this.deps.logger.warn(`could not enable ${kind}`, { code: this.lastError.code })
      }
      this.emit()
    })
  }

  // MARK: transitions

  private async runStart(): Promise<void> {
    if (this.phase !== 'idle') return
    const { engine, sessions, shield, logger } = this.deps
    this.phase = 'starting'
    this.lastError = null
    this.emit()

    let sessionId: string | null = null
    try {
      const { permissions } = await engine.getPermissions()
      if (permissions.screenRecording !== 'granted') {
        throw new CaptureError(appError('screen-recording-permission-denied'))
      }
      const source = this.source ?? (await this.findDefaultSource())
      this.source = source

      const session = await sessions
        .create(
          {
            source: toSessionSource(source),
            fps: RECORDING_CONFIG.fps,
            cursorInVideo: RECORDING_CONFIG.showCursor
          },
          this.deps.wallClock()
        )
        .catch((error: unknown) => {
          throw new CaptureError(storageError(error))
        })
      sessionId = session.manifest.id

      // The shield must be up before the first frame is captured.
      shield.engage()
      const ownPids = this.deps.ownPids()
      const options = this.options
      const info = await engine.start({
        outputPath: session.screenPath,
        source,
        excludePids: ownPids,
        fps: RECORDING_CONFIG.fps,
        showCursor: RECORDING_CONFIG.showCursor,
        telemetry: {
          cursorPath: session.cursorPath,
          interactionsPath: session.interactionsPath,
          sampleRateHz: RECORDING_CONFIG.cursorSampleRateHz
        },
        microphone: options.microphoneId
          ? { deviceId: options.microphoneId, outputPath: session.microphonePath }
          : null,
        systemAudio: options.systemAudio ? { outputPath: session.systemAudioPath } : null,
        webcam: options.cameraId
          ? { deviceId: options.cameraId, outputPath: session.webcamPath, fps: RECORDING_CONFIG.webcamFps }
          : null
      })

      const clock = new RecordingClock(this.deps.monotonicNow)
      clock.start()
      const diagnostics: SessionDiagnostic[] = []
      const selfExcluded = ownPids.some((pid) => info.excludedPids.includes(pid))
      if (source.kind === 'display' && !selfExcluded) {
        // Content protection on the windows still applies, but flag it.
        logger.warn('own application was not excluded from the capture', { ownPids })
        diagnostics.push({
          level: 'warning',
          code: 'self-exclusion-missing',
          message: 'The recorder could not exclude its own windows from the capture.'
        })
      }

      this.active = {
        manifest: session.manifest,
        screenPath: session.screenPath,
        clock,
        diagnostics,
        options
      }
      this.phase = 'recording'
      logger.info('started', {
        sessionId,
        source: sourceLabel(source),
        size: `${info.widthPx}x${info.heightPx}`,
        fps: info.fps,
        microphone: options.microphoneName,
        systemAudio: options.systemAudio,
        camera: options.cameraName
      })
      this.emit()
      this.notifyLibraryChanged()
    } catch (error) {
      const failure = toAppError(error)
      logger.error('start failed', { code: failure.code, detail: failure.detail })
      shield.release()
      if (sessionId) await sessions.discardEmpty(sessionId)
      if (failure.code === 'source-unavailable') this.source = null
      this.phase = 'idle'
      this.lastError = failure
      this.emit()
    }
  }

  private async runStop(): Promise<void> {
    const active = this.active
    if ((this.phase !== 'recording' && this.phase !== 'paused') || !active) return
    this.phase = 'stopping'
    active.clock.stop()
    this.emit()
    try {
      const result = await this.deps.engine.stop()
      await this.complete(active, result, null)
    } catch (error) {
      await this.fail(active, toAppError(error))
    }
  }

  private async handleInterruption(interruption: CaptureInterruption): Promise<void> {
    const active = this.active
    // While stopping, the pending stop request reports the outcome itself.
    if ((this.phase !== 'recording' && this.phase !== 'paused') || !active) return
    this.deps.logger.warn('capture interrupted', {
      code: interruption.error.code,
      detail: interruption.error.detail,
      recovered: interruption.result !== null
    })
    active.clock.stop()
    if (interruption.result) {
      await this.complete(active, interruption.result, interruption.error)
    } else {
      await this.fail(active, interruption.error)
    }
  }

  private async complete(
    active: ActiveRecording,
    result: CaptureResult,
    interruption: AppError | null
  ): Promise<void> {
    const { sessions, logger } = this.deps
    const sizeBytes = await sessions.fileSize(active.screenPath)
    if (!isUsableRecording(result, sizeBytes)) {
      const detail = `frames=${result.framesWritten} bytes=${sizeBytes} mediaMs=${result.mediaDurationMs}`
      await this.fail(active, appError('recording-invalid', detail))
      return
    }

    const diagnostics = [
      ...active.diagnostics,
      ...diagnoseCapture(result),
      ...diagnoseMissingTracks(result, active.options)
    ]
    if (!result.telemetry) {
      diagnostics.push({
        level: 'warning',
        code: 'telemetry-missing',
        message: 'Pointer telemetry was not recorded; automatic zooms are unavailable.'
      })
    }
    if (interruption) {
      diagnostics.push({
        level: 'warning',
        code: 'interrupted',
        message: interruption.detail ?? interruption.code
      })
    }
    for (const diagnostic of diagnostics) {
      logger[diagnostic.level === 'warning' ? 'warn' : 'info'](diagnostic.message, {
        sessionId: active.manifest.id,
        code: diagnostic.code
      })
    }

    const manifest: RecordingSessionManifest = {
      ...active.manifest,
      status: 'completed',
      clock: { durationMs: result.durationMs, pauses: result.pauses },
      assets: {
        screen: {
          file: SESSION_FILES.screen,
          sizeBytes,
          durationMs: result.mediaDurationMs,
          widthPx: result.widthPx,
          heightPx: result.heightPx,
          frameCount: result.framesWritten,
          droppedFrameCount: result.framesDropped
        },
        ...(result.microphone && {
          microphone: {
            file: SESSION_FILES.microphone,
            sizeBytes: result.microphone.fileSizeBytes,
            durationMs: result.microphone.durationMs,
            deviceName: active.options.microphoneName ?? ''
          }
        }),
        ...(result.systemAudio && {
          systemAudio: {
            file: SESSION_FILES.systemAudio,
            sizeBytes: result.systemAudio.fileSizeBytes,
            durationMs: result.systemAudio.durationMs
          }
        }),
        ...(result.webcam && {
          webcam: {
            file: SESSION_FILES.webcam,
            sizeBytes: result.webcam.fileSizeBytes,
            durationMs: result.webcam.durationMs,
            widthPx: result.webcam.widthPx ?? 0,
            heightPx: result.webcam.heightPx ?? 0,
            deviceName: active.options.cameraName ?? ''
          }
        }),
        ...(result.telemetry && {
          cursor: { file: SESSION_FILES.cursor, entryCount: result.telemetry.cursorSamples },
          interactions: {
            file: SESSION_FILES.interactions,
            entryCount: result.telemetry.interactions
          }
        })
      },
      diagnostics
    }

    let error = interruption
    try {
      await sessions.write(manifest)
      logger.info('finished', {
        sessionId: manifest.id,
        durationMs: Math.round(result.durationMs),
        bytes: sizeBytes,
        frames: result.framesWritten
      })
    } catch (writeError) {
      // The media is on disk, but without its manifest the session is not listed.
      error = storageError(writeError)
      logger.error('could not write session manifest', { sessionId: manifest.id, detail: error.detail })
    }
    this.finish(error, error === interruption ? manifest.id : null)
  }

  private async fail(active: ActiveRecording, error: AppError): Promise<void> {
    const { sessions, logger } = this.deps
    logger.error('recording failed', {
      sessionId: active.manifest.id,
      code: error.code,
      detail: error.detail
    })
    try {
      if ((await sessions.fileSize(active.screenPath)) === 0) {
        await sessions.discardEmpty(active.manifest.id)
      } else {
        // A partial file may be recoverable; keep it and record why it failed.
        await sessions.write({ ...active.manifest, status: 'failed', failure: error })
      }
    } catch (writeError) {
      logger.error('could not record session failure', { error: String(writeError) })
    }
    this.finish(error, null)
  }

  private finish(error: AppError | null, completedSessionId: string | null): void {
    this.deps.shield.release()
    this.active = null
    this.phase = 'idle'
    this.lastError = error
    if (completedSessionId) this.lastCompletedSessionId = completedSessionId
    this.emit()
    this.notifyLibraryChanged()
  }

  // MARK: helpers

  private listSourcesForSelection() {
    return this.deps.engine.listSources({
      excludePids: this.deps.ownPids(),
      includeWindows: true,
      thumbnailMaxWidthPx: null
    })
  }

  private async findDefaultSource(): Promise<CaptureSource> {
    const { permissions } = await this.deps.engine.getPermissions()
    if (permissions.screenRecording !== 'granted') {
      throw new CaptureError(appError('screen-recording-permission-denied'))
    }
    const catalog = await this.deps.engine.listSources({
      excludePids: this.deps.ownPids(),
      includeWindows: false,
      thumbnailMaxWidthPx: null
    })
    const source = catalog.displays.find((display) => display.isMain) ?? catalog.displays[0]
    if (!source) throw new CaptureError(appError('no-source-selected'))
    return source
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation).catch((error: unknown) => {
      // Operations handle their own failures; this is a last line of defence.
      this.deps.logger.error('unexpected controller failure', { error: String(error) })
    })
    this.queue = run
    return run
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.stateListeners) listener(state)
  }

  private notifyLibraryChanged(): void {
    for (const listener of this.libraryListeners) listener()
  }
}

function toSessionSource(source: CaptureSource): SessionSource {
  return source.kind === 'display'
    ? {
        kind: 'display',
        label: sourceLabel(source),
        displayId: source.displayId,
        windowId: null,
        appName: null
      }
    : {
        kind: 'window',
        label: sourceLabel(source),
        displayId: source.displayId,
        windowId: source.windowId,
        appName: source.appName
      }
}

function toAppError(error: unknown): AppError {
  return error instanceof CaptureError ? error.appError : appError('unknown', String(error))
}

function storageError(error: unknown): AppError {
  const code = (error as NodeJS.ErrnoException).code
  return appError(code === 'ENOSPC' ? 'disk-full' : 'storage-unavailable', String(error))
}
