import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { ImageAsset } from '@shared/models/session'
import type { FfmpegService } from '../export/FfmpegService'
import { isSafeFileName, resolveInside } from '../filesystem/safePaths'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class ImageImportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'ImageImportError'
  }
}

export interface ImageImporterDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
}

/** Image files the renderer can draw; HEIC and the like are not among them. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif']

/** Larger than this is not an overlay. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/**
 * Brings image files (logos, stickers, screenshots) into a session's
 * `assets/` folder, so layers can show them. The file is copied under a name
 * of its own; the original is never touched. The manifest lists each one
 * with its size, when FFprobe can read it (an SVG has none until drawn).
 */
export class ImageImporter {
  constructor(private readonly deps: ImageImporterDeps) {}

  /** Copies one image into the session and returns it as listed in the manifest. */
  async import(sessionId: string, filePath: string): Promise<ImageAsset> {
    const { ffmpeg, sessions, logger } = this.deps
    const manifest = await sessions.read(sessionId)
    if (!manifest) throw new ImageImportError(appError('invalid-state', 'session not found'))
    const extension = path.extname(filePath).slice(1).toLowerCase()
    if (!IMAGE_EXTENSIONS.includes(extension)) throw new ImageImportError(appError('image-unsupported', `not an image: ${path.basename(filePath)}`))
    const { size } = await stat(filePath)
    if (size > MAX_IMAGE_BYTES) throw new ImageImportError(appError('image-unsupported', 'image file too large'))

    const file = `${randomUUID()}.${extension}`
    const directory = this.assetsDirectory(sessionId)
    const target = path.join(directory, file)
    try {
      await mkdir(directory, { recursive: true })
      await copyFile(filePath, target)
      const probed = extension === 'svg' ? null : await ffmpeg.probeMedia(target).catch(() => null)
      const image: ImageAsset = {
        file,
        name: path.basename(filePath),
        sizeBytes: size,
        widthPx: probed?.video?.widthPx ?? 0,
        heightPx: probed?.video?.heightPx ?? 0
      }
      const images = [...(manifest.assets.images ?? []), image]
      await sessions.write({ ...manifest, assets: { ...manifest.assets, images } })
      logger.info('image imported', { sessionId, file, name: image.name, size: `${image.widthPx}x${image.heightPx}` })
      return image
    } catch (error) {
      await rm(target, { force: true })
      logger.error('image import failed', { sessionId, file: filePath, error: String(error) })
      throw error instanceof ImageImportError ? error : new ImageImportError(appError('image-failed', String(error)))
    }
  }

  /** Removes one image file from the session and forgets it in the manifest. */
  async remove(sessionId: string, file: string): Promise<void> {
    const { sessions } = this.deps
    if (!isSafeFileName(file)) throw new ImageImportError(appError('invalid-state', 'invalid image name'))
    const manifest = await sessions.read(sessionId)
    if (!manifest) throw new ImageImportError(appError('invalid-state', 'session not found'))
    await rm(resolveInside(this.assetsDirectory(sessionId), file), { force: true })
    const images = (manifest.assets.images ?? []).filter((image) => image.file !== file)
    await sessions.write({ ...manifest, assets: { ...manifest.assets, images } })
  }

  /** The folder a session's images live in. */
  assetsDirectory(sessionId: string): string {
    return path.join(this.deps.sessions.directoryOf(sessionId), SESSION_FILES.assets)
  }
}

export function toImageAppError(error: unknown): AppError {
  return error instanceof ImageImportError ? error.appError : appError('image-failed', String(error))
}
