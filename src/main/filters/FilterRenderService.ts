import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { detectionFilters, planRender } from '@engine/filters/filterChain'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { FilterRenderProgress, FilterRenderRequest, FilterTrack } from '@shared/models/filters'
import { renderKey } from '@shared/models/filters'
import { trackUrl } from '@shared/models/media'
import { FfmpegCancelledError, type FfmpegService } from '../export/FfmpegService'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import { importBitrate } from '../library/VideoImporter'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class FilterRenderError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'FilterRenderError'
  }
}

export interface FilterRenderServiceOptions {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
  onProgress: (progress: FilterRenderProgress) => void
}

/** What `screen-fx.json` says about the track beside it. */
export interface FilterTrackInfo {
  schemaVersion: 1
  /** `renderKey` of the settings the track was made from. */
  key: string
  request: FilterRenderRequest
}

/**
 * Renders the screen track with the effects that need FFmpeg — stabilization,
 * noise reduction, sharpening — as `screen-fx.mp4` in the session, with
 * `screen-fx.json` saying what it was made from. Derived data: made again
 * whenever those settings change, never the recording itself. One rendering
 * at a time; cancelling kills FFmpeg and leaves the previous track in place.
 */
export class FilterRenderService {
  private running: { sessionId: string; cancel: () => void } | null = null

  constructor(private readonly options: FilterRenderServiceOptions) {}

  async render(sessionId: string, request: FilterRenderRequest): Promise<FilterTrack> {
    const { ffmpeg, sessions, logger, onProgress } = this.options
    if (this.running) throw new FilterRenderError(appError('filters-busy'))
    const manifest = await sessions.read(sessionId)
    const screen = manifest?.assets.screen
    if (!screen) throw new FilterRenderError(appError('filters-failed', 'session has no screen track'))

    const key = renderKey({ ...request, color: { brightness: 1, contrast: 1, saturation: 1 } })
    const inputPath = sessions.trackPathOf(sessionId, 'screen')
    const outputPath = sessions.trackPathOf(sessionId, 'screenFx')
    const partialPath = `${outputPath}.part`
    const transformsPath = path.join(sessions.directoryOf(sessionId), 'screen-fx.trf')
    const plan = planRender(request)
    const bitrate = importBitrate(screen.widthPx, screen.heightPx, manifest.capture.fps)
    const startedAt = Date.now()
    // With a detection pass, the first half of the progress is its; the rendering pass takes the rest.
    const passes = plan.detect ? 2 : 1
    const report = (pass: number, fraction: number): void => onProgress({ sessionId, fraction: (pass + fraction) / passes })

    const run = { sessionId, cancel: () => undefined as void }
    this.running = run
    try {
      if (plan.detect) {
        const detection = ffmpeg.filterVideo(inputPath, null, {
          filters: detectionFilters(transformsPath),
          bitrate,
          durationMs: screen.durationMs,
          onProgress: (fraction) => report(0, fraction)
        })
        run.cancel = detection.cancel
        await detection.done
      }
      const rendering = ffmpeg.filterVideo(inputPath, partialPath, {
        filters: plan.filters(plan.detect ? transformsPath : null),
        bitrate,
        durationMs: screen.durationMs,
        onProgress: (fraction) => report(passes - 1, fraction)
      })
      run.cancel = rendering.cancel
      await rendering.done
      await rename(partialPath, outputPath)
      const info: FilterTrackInfo = { schemaVersion: 1, key, request }
      await writeJsonAtomic(path.join(sessions.directoryOf(sessionId), SESSION_FILES.screenFxInfo), info)
      logger.info('effects rendered', { sessionId, key, elapsedMs: Date.now() - startedAt })
      return { url: trackUrl(sessionId, 'screenFx'), key }
    } catch (error) {
      await rm(partialPath, { force: true })
      if (error instanceof FfmpegCancelledError) throw new FilterRenderError(appError('filters-cancelled'))
      logger.error('effects failed', { sessionId, error: String(error) })
      throw error instanceof FilterRenderError ? error : new FilterRenderError(appError('filters-failed', String(error)))
    } finally {
      await rm(transformsPath, { force: true })
      if (this.running === run) this.running = null
    }
  }

  cancel(): void {
    this.running?.cancel()
  }

  /** The rendered track a session has, if its description is readable; `null` otherwise. */
  async trackOf(sessionId: string): Promise<FilterTrack | null> {
    const { sessions } = this.options
    try {
      const raw = JSON.parse(await readFile(path.join(sessions.directoryOf(sessionId), SESSION_FILES.screenFxInfo), 'utf8')) as Partial<FilterTrackInfo>
      if (raw.schemaVersion !== 1 || typeof raw.key !== 'string') return null
      await readFile(sessions.trackPathOf(sessionId, 'screenFx'), { flag: 'r' }).then(
        () => undefined,
        () => {
          throw new Error('no track')
        }
      )
      return { url: trackUrl(sessionId, 'screenFx'), key: raw.key }
    } catch {
      return null
    }
  }
}
