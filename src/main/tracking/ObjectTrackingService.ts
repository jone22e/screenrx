import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { CursorSample, ObjectTrack, ObjectTrackRequest } from '@shared/models/telemetry'
import { OBJECT_TRACK_SCHEMA_VERSION } from '@shared/models/telemetry'
import { JsonLineDecoder } from '../capture/macos/JsonLineDecoder'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class ObjectTrackingError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'ObjectTrackingError'
  }
}

export interface ObjectTrackingServiceOptions {
  /** The native tracker, or `null` on a platform that has none. */
  binaryPath: string | null
  sessions: SessionStore
  logger: Logger
  onProgress: (progress: { sessionId: string; fraction: number }) => void
}

/**
 * Follows an object the user marked through the screen track, with the
 * native tracker (Vision, on this Mac), and keeps where it went as
 * `track.json` in the session — derived data, made again whenever the user
 * marks something else. One tracking at a time; cancelling kills the helper.
 */
export class ObjectTrackingService {
  private running: { child: ChildProcess; cancelled: boolean } | null = null

  constructor(private readonly options: ObjectTrackingServiceOptions) {}

  async track(sessionId: string, request: ObjectTrackRequest): Promise<ObjectTrack> {
    const { binaryPath, sessions, logger } = this.options
    if (this.running) throw new ObjectTrackingError(appError('invalid-state', 'already tracking'))
    if (!binaryPath) throw new ObjectTrackingError(appError('unknown', 'no tracker on this platform'))
    const manifest = await sessions.read(sessionId)
    if (!manifest?.assets.screen) throw new ObjectTrackingError(appError('invalid-state', 'session has no screen track'))

    const startedAt = Date.now()
    const samples = await this.run(binaryPath, sessionId, sessions.trackPathOf(sessionId, 'screen'), request)
    if (samples.length === 0) throw new ObjectTrackingError(appError('unknown', 'the object was not seen at all'))
    const track: ObjectTrack = {
      schemaVersion: OBJECT_TRACK_SCHEMA_VERSION,
      rect: request.rect,
      startMs: request.startMs,
      endMs: samples[samples.length - 1]?.timeMs ?? request.startMs,
      samples
    }
    await writeJsonAtomic(path.join(sessions.directoryOf(sessionId), SESSION_FILES.track), track)
    logger.info('object tracked', { sessionId, samples: samples.length, fromMs: track.startMs, toMs: track.endMs, elapsedMs: Date.now() - startedAt })
    return track
  }

  cancel(): void {
    if (!this.running) return
    this.running.cancelled = true
    this.running.child.kill('SIGTERM')
  }

  private run(binaryPath: string, sessionId: string, videoPath: string, request: ObjectTrackRequest): Promise<CursorSample[]> {
    const { logger, onProgress } = this.options
    const { rect } = request
    return new Promise((resolve, reject) => {
      const child = spawn(
        binaryPath,
        ['--input', videoPath, '--start-ms', String(request.startMs), '--rect', [rect.x, rect.y, rect.width, rect.height].join(',')],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const run = { child, cancelled: false }
      this.running = run
      const samples: CursorSample[] = []
      let finished = false
      let failure: AppError | null = null
      let stderr = ''

      const decoder = new JsonLineDecoder(
        (message) => {
          if (typeof message !== 'object' || message === null) return
          const { type, timeMs, x, y, fraction, code, detail } = message as Record<string, unknown>
          if (type === 'sample' && typeof timeMs === 'number' && typeof x === 'number' && typeof y === 'number') {
            samples.push({ timeMs, x, y })
          } else if (type === 'progress' && typeof fraction === 'number') {
            onProgress({ sessionId, fraction: Math.min(Math.max(fraction, 0), 1) })
          } else if (type === 'done') {
            finished = true
          } else if (type === 'error') {
            failure = appError('unknown', `${typeof code === 'string' ? code : 'failed'}: ${typeof detail === 'string' ? detail : ''}`)
          }
        },
        (reason) => logger.warn('tracker sent an invalid line', { reason })
      )
      child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      const settle = (error: AppError | null): void => {
        if (this.running !== run) return
        this.running = null
        if (error) reject(new ObjectTrackingError(error))
        else resolve(samples)
      }
      child.once('error', (error) => settle(appError('unknown', String(error))))
      child.once('close', (exitCode, signal) => {
        if (run.cancelled) settle(appError('invalid-state', 'tracking cancelled'))
        else if (failure) settle(failure)
        else if (exitCode === 0 && finished) settle(null)
        else settle(appError('unknown', `tracker exit ${exitCode ?? signal ?? '?'}: ${stderr.trim()}`))
      })
    })
  }
}
