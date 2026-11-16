import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { VideoClipAsset } from '@shared/models/session'
import type { FfmpegService } from '../export/FfmpegService'
import { isSafeFileName, resolveInside } from '../filesystem/safePaths'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { canCopyVideo, importBitrate } from './VideoImporter'

export class ClipImportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'ClipImportError'
  }
}

export interface ClipImporterDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
}

/** Longest clip taken as b-roll. */
const MAX_CLIP_MS = 60 * 60 * 1000
const FALLBACK_FPS = 30

/**
 * Brings a video file into a session's `assets/` folder as b-roll: H.264 in
 * MP4 (copied when it already is, re-encoded otherwise), without its audio
 * — b-roll plays under the recording's own sound. The original file is
 * never touched.
 */
export class ClipImporter {
  constructor(private readonly deps: ClipImporterDeps) {}

  async import(sessionId: string, filePath: string): Promise<VideoClipAsset> {
    const { ffmpeg, sessions, logger } = this.deps
    const manifest = await sessions.read(sessionId)
    if (!manifest) throw new ClipImportError(appError('invalid-state', 'session not found'))
    let probe
    try {
      probe = await ffmpeg.probeMedia(filePath)
    } catch (error) {
      throw new ClipImportError(appError('import-unsupported', String(error)))
    }
    const video = probe.video
    if (!video) throw new ClipImportError(appError('import-unsupported', `no video stream in ${path.basename(filePath)}`))
    if (probe.durationMs > MAX_CLIP_MS) throw new ClipImportError(appError('import-unsupported', 'clip too long'))

    const file = `${randomUUID()}.mp4`
    const directory = path.join(sessions.directoryOf(sessionId), SESSION_FILES.assets)
    const target = path.join(directory, file)
    const partial = `${target}.part`
    try {
      await mkdir(directory, { recursive: true })
      const fps = video.fps > 0 ? Math.round(video.fps) : FALLBACK_FPS
      await ffmpeg.writeVideoTrack(filePath, partial, { copy: canCopyVideo(video), bitrate: importBitrate(video.widthPx, video.heightPx, fps) })
      const [size, written] = await Promise.all([stat(partial), ffmpeg.probeMedia(partial)])
      if (!written.video) throw new ClipImportError(appError('import-failed', 'clip has no video after import'))
      await rename(partial, target)
      const clip: VideoClipAsset = {
        file,
        name: path.basename(filePath),
        sizeBytes: size.size,
        durationMs: Math.round(written.durationMs),
        widthPx: written.video.widthPx,
        heightPx: written.video.heightPx
      }
      const videos = [...(manifest.assets.videos ?? []), clip]
      await sessions.write({ ...manifest, assets: { ...manifest.assets, videos } })
      logger.info('clip imported', { sessionId, file, name: clip.name, durationMs: clip.durationMs })
      return clip
    } catch (error) {
      await rm(partial, { force: true })
      await rm(target, { force: true })
      logger.error('clip import failed', { sessionId, file: filePath, error: String(error) })
      throw error instanceof ClipImportError ? error : new ClipImportError(appError('import-failed', String(error)))
    }
  }

  async remove(sessionId: string, file: string): Promise<void> {
    const { sessions } = this.deps
    if (!isSafeFileName(file)) throw new ClipImportError(appError('invalid-state', 'invalid clip name'))
    const manifest = await sessions.read(sessionId)
    if (!manifest) throw new ClipImportError(appError('invalid-state', 'session not found'))
    await rm(resolveInside(path.join(sessions.directoryOf(sessionId), SESSION_FILES.assets), file), { force: true })
    const videos = (manifest.assets.videos ?? []).filter((clip) => clip.file !== file)
    await sessions.write({ ...manifest, assets: { ...manifest.assets, videos } })
  }
}

export function toClipAppError(error: unknown): AppError {
  return error instanceof ClipImportError ? error.appError : appError('import-failed', String(error))
}
