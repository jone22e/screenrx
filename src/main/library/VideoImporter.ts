import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { RecordingSessionManifest, SessionDiagnostic } from '@shared/models/session'
import type { FfmpegService, MediaProbe } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class ImportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'ImportError'
  }
}

export interface VideoImporterDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
  now?: () => Date
}

/** Frame rate written to the manifest when the file does not state one. */
const FALLBACK_FPS = 30

/**
 * Brings a video recorded elsewhere into the library as a session of its own,
 * so it opens in the editor like any recording. The original file is never
 * touched: its video becomes the session's screen track (H.264 in MP4, copied
 * when it already is, re-encoded otherwise) and its audio, when it has any,
 * becomes the microphone track — the one captions and dubbing work from.
 * There is no pointer telemetry, so no automatic zooms.
 */
export class VideoImporter {
  constructor(private readonly deps: VideoImporterDeps) {}

  /** Imports one file and returns the new session's id; throws an `ImportError` when it cannot. */
  async import(filePath: string): Promise<string> {
    const { ffmpeg, sessions, logger } = this.deps
    const probe = await this.probe(filePath)
    const video = probe.video
    if (!video) throw new ImportError(appError('import-unsupported', `no video stream in ${path.basename(filePath)}`))

    const fps = video.fps > 0 ? Math.round(video.fps) : FALLBACK_FPS
    const label = path.basename(filePath, path.extname(filePath))
    // The file's name is the recording's title, as the source's label is for a captured screen.
    const created = await sessions.create(
      { source: { kind: 'file', label, displayId: null, windowId: null, appName: null }, fps, cursorInVideo: true },
      (this.deps.now ?? (() => new Date()))()
    )
    const sessionId = created.manifest.id
    logger.info('importing video', {
      sessionId,
      file: filePath,
      codec: video.codec,
      audio: probe.audio?.codec ?? null,
      size: `${video.widthPx}x${video.heightPx}`
    })

    try {
      const copyVideo = canCopyVideo(video)
      await ffmpeg.writeVideoTrack(filePath, created.screenPath, {
        copy: copyVideo,
        bitrate: importBitrate(video.widthPx, video.heightPx, fps)
      })
      if (probe.audio) {
        await ffmpeg.writeAudioTrack(filePath, created.microphonePath, probe.audio.codec === 'aac')
      }
      const manifest = await this.describe(created.manifest, created.screenPath, probe.audio ? created.microphonePath : null)
      await sessions.write(manifest)
      logger.info('video imported', { sessionId, durationMs: manifest.clock.durationMs, copied: copyVideo })
      return sessionId
    } catch (error) {
      // A half-made session would show up as a broken recording; it is ours alone, so it is removed whole.
      await rm(created.directory, { recursive: true, force: true })
      logger.error('video import failed', { sessionId, file: filePath, error: String(error) })
      throw error instanceof ImportError ? error : new ImportError(appError('import-failed', String(error)))
    }
  }

  private async probe(filePath: string): Promise<MediaProbe> {
    try {
      return await this.deps.ffmpeg.probeMedia(filePath)
    } catch (error) {
      throw new ImportError(appError('import-unsupported', String(error)))
    }
  }

  /** Reads the written tracks back, so the manifest tells what is actually on disk. */
  private async describe(
    draft: RecordingSessionManifest,
    screenPath: string,
    audioPath: string | null
  ): Promise<RecordingSessionManifest> {
    const { ffmpeg } = this.deps
    const [packets, screenSize, screen] = await Promise.all([
      ffmpeg.probeVideoPackets(screenPath),
      stat(screenPath),
      ffmpeg.probeMedia(screenPath)
    ])
    if (packets.length === 0 || !packets[0]?.keyframe || !screen.video) {
      throw new ImportError(appError('import-failed', 'imported track has no decodable frames'))
    }
    const durationMs = screen.durationMs
    const diagnostics: SessionDiagnostic[] = [
      {
        level: 'info',
        code: 'telemetry-missing',
        message: 'Imported video: no pointer telemetry, so automatic zooms are unavailable.'
      }
    ]
    const audio = audioPath
      ? {
          microphone: {
            file: SESSION_FILES.microphone,
            sizeBytes: (await stat(audioPath)).size,
            durationMs: Math.round(await ffmpeg.durationOf(audioPath)),
            deviceName: 'Áudio do vídeo importado'
          }
        }
      : {}
    return {
      ...draft,
      status: 'completed',
      clock: { durationMs, pauses: [] },
      assets: {
        screen: {
          file: SESSION_FILES.screen,
          sizeBytes: screenSize.size,
          durationMs,
          widthPx: screen.video.widthPx,
          heightPx: screen.video.heightPx,
          frameCount: packets.length,
          droppedFrameCount: 0
        },
        ...audio
      },
      diagnostics
    }
  }
}

/** Pixel formats WebCodecs decodes everywhere; anything else (10-bit, 4:4:4) is re-encoded. */
const COPYABLE_PIXEL_FORMATS = new Set(['yuv420p', 'yuvj420p'])

/** H.264 in a common pixel format goes in as is; everything else is re-encoded. */
export function canCopyVideo(video: NonNullable<MediaProbe['video']>): boolean {
  return video.codec === 'h264' && video.pixelFormat !== null && COPYABLE_PIXEL_FORMATS.has(video.pixelFormat)
}

/** Same rule as the export: bits proportional to pixels per second, within the export's bounds. */
export function importBitrate(widthPx: number, heightPx: number, fps: number): number {
  const bitrate = widthPx * heightPx * fps * EXPORT_CONFIG.bitsPerPixelPerFrame
  return Math.round(Math.min(Math.max(bitrate, EXPORT_CONFIG.minVideoBitrate), EXPORT_CONFIG.maxVideoBitrate))
}

export function toImportAppError(error: unknown): AppError {
  return error instanceof ImportError ? error.appError : appError('import-failed', String(error))
}
