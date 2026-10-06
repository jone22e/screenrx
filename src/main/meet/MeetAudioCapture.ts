import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import type { IpcMainEvent, WebContents } from 'electron'
import { ipcMain } from 'electron'
import type { SessionPause } from '@shared/models/session'
import type { FfmpegService } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import { buildAudioFilter } from './audioAlign'

/** What the recording controller tells the capture when the recording ends. */
export interface FinishContext {
  /** Where the track must be written (the session's system-audio file). */
  outputPath: string
  /** Wall clock (ms since the epoch) at which the recording clock started. */
  startedAtWallMs: number
  /** Length of the recording on its clock, pauses excluded. */
  durationMs: number
  pauses: readonly SessionPause[]
}

export interface FinishedAudio {
  sizeBytes: number
  durationMs: number
}

interface Capture {
  sender: WebContents
  origin: string
  file: string
  stream: WriteStream
  /** Wall clock at which the page started recording; unknown until it says so. */
  startedAtMs: number | null
  bytes: number
  ended: Promise<void>
  markEnded: () => void
}

/** A meeting is not recorded for longer than a day, and a runaway page must not fill the disk. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024
const STOP_TIMEOUT_MS = 4000
/** The page's clock and ours are the same machine's: anything far off is not a real start. */
const MAX_START_SKEW_MS = 60 * 60 * 1000

/**
 * Receives the meeting's audio from the meeting window (it is captured inside the page, because the
 * system's screen capture does not deliver a window's audio for this app) and turns it into the
 * session's system-audio track: started and cut at the recording clock's zero, pauses removed.
 *
 * Only the window prepared for the current meeting is listened to, and only its top frame at the
 * meeting's origin; anything else is ignored.
 */
export class MeetAudioCapture {
  private capture: Capture | null = null

  constructor(
    private readonly directory: string,
    private readonly ffmpeg: FfmpegService,
    private readonly logger: Logger
  ) {
    ipcMain.on('meet-audio:begin', (event, startedAtMs: unknown) => {
      const capture = this.accept(event)
      if (!capture || typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return
      if (Math.abs(Date.now() - startedAtMs) > MAX_START_SKEW_MS) return
      capture.startedAtMs ??= startedAtMs
    })
    ipcMain.on('meet-audio:chunk', (event, data: unknown) => {
      const capture = this.accept(event)
      if (!capture || capture.startedAtMs === null) return
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null
      if (!bytes || capture.bytes + bytes.length > MAX_CAPTURE_BYTES) return
      capture.bytes += bytes.length
      capture.stream.write(bytes)
    })
    ipcMain.on('meet-audio:end', (event) => {
      this.accept(event)?.markEnded()
    })
  }

  /** Starts listening to `sender`, the meeting window's page, which will be at `origin`. */
  async prepare(sender: WebContents, origin: string): Promise<void> {
    await this.discard()
    await mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, `meeting-${Date.now()}.webm`)
    let markEnded = (): void => undefined
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve
    })
    this.capture = {
      sender,
      origin,
      file,
      stream: createWriteStream(file),
      startedAtMs: null,
      bytes: 0,
      ended,
      markEnded
    }
  }

  /**
   * Ends the capture and writes the track for the finished recording. `null` when nothing usable
   * was captured (no capture prepared, the page never started, or the audio is empty).
   */
  async finish(context: FinishContext): Promise<FinishedAudio | null> {
    const capture = this.capture
    if (!capture) return null
    try {
      await this.stopPage(capture)
      capture.stream.end()
      await once(capture.stream, 'close')
      if (capture.startedAtMs === null || capture.bytes === 0) {
        this.logger.warn('meeting audio: nothing was captured', { bytes: capture.bytes })
        return null
      }
      const offsetMs = context.startedAtWallMs - capture.startedAtMs
      await this.ffmpeg.renderAudio(
        capture.file,
        context.outputPath,
        buildAudioFilter({ offsetMs, durationMs: context.durationMs, pauses: context.pauses })
      )
      const [durationMs, sizeBytes] = await Promise.all([
        this.ffmpeg.durationOf(context.outputPath),
        stat(context.outputPath).then((info) => info.size)
      ])
      this.logger.info('meeting audio written', { offsetMs: Math.round(offsetMs), capturedBytes: capture.bytes, durationMs: Math.round(durationMs) })
      return { sizeBytes, durationMs }
    } finally {
      await this.discard()
    }
  }

  /** Drops whatever is being captured (the recording did not happen, or it is over). */
  async discard(): Promise<void> {
    const capture = this.capture
    this.capture = null
    if (!capture) return
    capture.markEnded()
    if (!capture.stream.closed) {
      capture.stream.destroy()
    }
    await rm(capture.file, { force: true })
  }

  /** The page flushes its last pieces and says so; if it is gone or silent, the wait is bounded. */
  private async stopPage(capture: Capture): Promise<void> {
    if (capture.sender.isDestroyed()) return
    capture.sender.send('meet-audio:stop')
    await Promise.race([capture.ended, new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))])
  }

  private accept(event: IpcMainEvent): Capture | null {
    const capture = this.capture
    if (!capture || event.sender !== capture.sender) return null
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return null
    try {
      return new URL(frame.url).origin === capture.origin ? capture : null
    } catch {
      return null
    }
  }
}
