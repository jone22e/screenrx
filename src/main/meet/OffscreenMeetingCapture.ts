import { once } from 'node:events'
import { stat, writeFile } from 'node:fs/promises'
import type { BrowserWindow, NativeImage } from 'electron'
import type { Unsubscribe } from '@shared/ipc/contract'
import type { WindowSource } from '@shared/models/capture'
import { windowSourceId } from '@shared/models/capture'
import { appError } from '@shared/models/errors'
import type { SessionPause } from '@shared/models/session'
import type {
  CaptureInterruption,
  CaptureResult,
  CaptureStartInfo,
  CaptureTimeMark,
  StartCaptureRequest
} from '../capture/CaptureEngine'
import { CaptureError } from '../capture/CaptureEngine'
import type { FfmpegProcess, FfmpegService } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'

/**
 * Source ids of meeting windows start here, far above anything the system numbers its windows with, so
 * the id of a meeting window can never be taken for a real one.
 */
const OFFSCREEN_SOURCE_BASE = 2_000_000_000
const FIRST_FRAME_TIMEOUT_MS = 8000
const PUMP_INTERVAL_MS = 8
const VIDEO_BITRATE = '8M'

interface Meeting {
  window: BrowserWindow
  source: WindowSource
  /** The newest frame the page has drawn. */
  image: NativeImage | null
  /** `image` as raw pixels, converted once however many times the frame is repeated. */
  bitmap: Buffer | null
  bitmapOf: NativeImage | null
}

interface Run {
  request: StartCaptureRequest
  process: FfmpegProcess
  width: number
  height: number
  fps: number
  framesWritten: number
  /** Recording time of the stretches already behind us; the running stretch is added on top. */
  accumulatedMs: number
  /** `performance.now()` at which the running stretch began; `null` while paused. */
  runningSince: number | null
  pausedAt: { recordingTimeMs: number; wallMs: number } | null
  pauses: SessionPause[]
  recording: boolean
  pump: Promise<void>
}

/**
 * Records a meeting without any window on screen: the meeting page is drawn off screen by Electron, and its
 * frames go straight to an FFmpeg that encodes them into the session's screen track. Frames are written at a
 * constant rate against the recording clock (a still page repeats its last frame), and not at all while
 * paused, so the track lasts exactly as long as the clock ran.
 *
 * This replaces screen capture for meetings: the system's window capture stops delivering frames for a window
 * that is hidden, minimized or transparent, so it could not run without a window in view.
 */
export class OffscreenMeetingCapture {
  private meeting: Meeting | null = null
  private run: Run | null = null
  private readonly interruptionListeners = new Set<(interruption: CaptureInterruption) => void>()

  constructor(
    private readonly ffmpeg: FfmpegService,
    private readonly logger: Logger
  ) {}

  /** Starts following the meeting page drawn by `window` and describes it as a capture source. */
  register(window: BrowserWindow, title: string, appName: string): WindowSource {
    this.release()
    const [width, height] = window.getContentSize()
    const source: WindowSource = {
      kind: 'window',
      id: windowSourceId(OFFSCREEN_SOURCE_BASE + window.id),
      windowId: OFFSCREEN_SOURCE_BASE + window.id,
      title,
      appName,
      bundleId: '',
      displayId: null,
      widthPx: width ?? 0,
      heightPx: height ?? 0,
      thumbnailDataUrl: null
    }
    const meeting: Meeting = { window, source, image: null, bitmap: null, bitmapOf: null }
    window.webContents.on('paint', (_event, _dirty, image) => {
      meeting.image = image
    })
    this.meeting = meeting
    return source
  }

  /** Whether `windowId` is the id of the registered meeting window. */
  owns(windowId: number): boolean {
    return this.meeting !== null && this.meeting.source.windowId === windowId
  }

  /** Forgets the meeting window (it is closed, or the recording is over). */
  release(): void {
    this.meeting = null
  }

  onInterrupted(listener: (interruption: CaptureInterruption) => void): Unsubscribe {
    this.interruptionListeners.add(listener)
    return () => this.interruptionListeners.delete(listener)
  }

  async start(request: StartCaptureRequest): Promise<CaptureStartInfo> {
    const meeting = this.meeting
    if (request.source.kind !== 'window' || !meeting || meeting.source.windowId !== request.source.windowId) {
      throw new CaptureError(appError('source-unavailable', 'the meeting is no longer open'))
    }
    if (this.run) throw new CaptureError(appError('invalid-state', 'a meeting recording is already running'))

    const first = await this.firstFrame(meeting)
    const { width, height } = first.getSize()
    // yuv420p needs even sides; the window is created that way, and a page cannot change it.
    if (width < 2 || height < 2 || width % 2 !== 0 || height % 2 !== 0) {
      throw new CaptureError(appError('capture-failed', `unsupported frame size ${width}x${height}`))
    }

    const encoder = await this.ffmpeg.selectH264Encoder()
    const video =
      encoder === 'h264_videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-b:v', VIDEO_BITRATE, '-profile:v', 'high', '-allow_sw', '1']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high']
    const process = this.ffmpeg.spawn([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'bgra',
      '-video_size', `${width}x${height}`,
      '-framerate', String(request.fps),
      '-i', '-',
      ...video,
      '-pix_fmt', 'yuv420p',
      // A short GOP keeps scrubbing in the editor responsive, as in the other recordings.
      '-g', String(request.fps),
      '-movflags', '+faststart',
      request.outputPath
    ])

    // A meeting has no pointer to follow: the session gets empty telemetry rather than a warning.
    if (request.telemetry) {
      await Promise.all([
        writeFile(request.telemetry.cursorPath, '[]\n', { flag: 'wx' }),
        writeFile(request.telemetry.interactionsPath, '[]\n', { flag: 'wx' })
      ])
    }

    const run: Run = {
      request,
      process,
      width,
      height,
      fps: request.fps,
      framesWritten: 0,
      accumulatedMs: 0,
      runningSince: performance.now(),
      pausedAt: null,
      pauses: [],
      recording: true,
      pump: Promise.resolve()
    }
    this.run = run
    process.done.then(
      () => undefined,
      (error: unknown) => {
        if (this.run === run && run.recording) this.interrupt(run, error)
      }
    )
    run.pump = this.pumpFrames(run, meeting)
    this.logger.info('meeting capture started', { size: `${width}x${height}`, fps: run.fps, encoder })
    return { widthPx: width, heightPx: height, fps: run.fps, excludedPids: [] }
  }

  async pause(): Promise<CaptureTimeMark> {
    const run = this.active()
    if (run.runningSince === null) return { recordingTimeMs: this.elapsedMs(run) }
    const now = performance.now()
    run.accumulatedMs += now - run.runningSince
    run.runningSince = null
    run.pausedAt = { recordingTimeMs: run.accumulatedMs, wallMs: now }
    return { recordingTimeMs: run.accumulatedMs }
  }

  async resume(): Promise<CaptureTimeMark> {
    const run = this.active()
    if (run.runningSince !== null || !run.pausedAt) return { recordingTimeMs: this.elapsedMs(run) }
    const now = performance.now()
    run.pauses.push({ atMs: run.pausedAt.recordingTimeMs, pausedForMs: now - run.pausedAt.wallMs })
    run.pausedAt = null
    run.runningSince = now
    return { recordingTimeMs: run.accumulatedMs }
  }

  async stop(): Promise<CaptureResult> {
    const run = this.active()
    const meeting = this.meeting
    const durationMs = this.elapsedMs(run)
    run.recording = false
    await run.pump
    // Whatever the clock still owes the track is written now, so it ends where the clock does.
    if (meeting) await this.writeDue(run, meeting, Math.max(1, Math.round((durationMs * run.fps) / 1000)))
    run.process.stdin.end()
    try {
      await run.process.done
    } catch (error) {
      this.run = null
      throw new CaptureError(appError('capture-failed', `video encoder: ${String(error)}`))
    }
    this.run = null
    const { outputPath } = run.request
    const [mediaDurationMs, info] = await Promise.all([this.ffmpeg.durationOf(outputPath), stat(outputPath)])
    this.logger.info('meeting capture finished', { frames: run.framesWritten, durationMs: Math.round(durationMs) })
    return {
      outputPath,
      durationMs,
      mediaDurationMs,
      fileSizeBytes: info.size,
      widthPx: run.width,
      heightPx: run.height,
      framesWritten: run.framesWritten,
      framesDropped: 0,
      pauses: run.pauses,
      telemetry: run.request.telemetry ? { cursorSamples: 0, interactions: 0 } : null,
      microphone: null,
      systemAudio: null,
      webcam: null
    }
  }

  async dispose(): Promise<void> {
    const run = this.run
    if (!run) return
    run.recording = false
    run.process.cancel()
    this.run = null
  }

  private active(): Run {
    if (!this.run) throw new CaptureError(appError('invalid-state', 'no meeting recording is running'))
    return this.run
  }

  private elapsedMs(run: Run): number {
    return run.accumulatedMs + (run.runningSince !== null ? performance.now() - run.runningSince : 0)
  }

  /** Waits for the page's first drawn frame, which is what a recording starts from. */
  private async firstFrame(meeting: Meeting): Promise<NativeImage> {
    const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS
    while (!meeting.image) {
      if (Date.now() > deadline || meeting.window.isDestroyed()) {
        throw new CaptureError(appError('capture-failed', 'the meeting page drew no frame'))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return meeting.image
  }

  private async pumpFrames(run: Run, meeting: Meeting): Promise<void> {
    while (run.recording) {
      if (run.runningSince !== null) {
        const due = Math.floor((this.elapsedMs(run) * run.fps) / 1000) + 1
        await this.writeDue(run, meeting, due)
      }
      await new Promise((resolve) => setTimeout(resolve, PUMP_INTERVAL_MS))
    }
  }

  /** Writes frames (the newest the page drew, repeated if it drew nothing new) until `due` have been written. */
  private async writeDue(run: Run, meeting: Meeting, due: number): Promise<void> {
    while (run.framesWritten < due) {
      const frame = this.frameOf(meeting)
      if (!frame) return
      run.framesWritten += 1
      if (!run.process.stdin.write(frame)) {
        // FFmpeg is behind: wait for it instead of piling frames up in memory.
        await Promise.race([once(run.process.stdin, 'drain').catch(() => undefined), run.process.done.catch(() => undefined)])
      }
    }
  }

  private frameOf(meeting: Meeting): Buffer | null {
    if (!meeting.image) return null
    if (meeting.bitmapOf !== meeting.image) {
      meeting.bitmap = meeting.image.toBitmap()
      meeting.bitmapOf = meeting.image
    }
    return meeting.bitmap
  }

  private interrupt(run: Run, error: unknown): void {
    this.logger.error('meeting capture interrupted', { error: String(error) })
    run.recording = false
    this.run = null
    const interruption: CaptureInterruption = { error: appError('capture-failed', String(error)), result: null }
    for (const listener of this.interruptionListeners) listener(interruption)
  }
}
