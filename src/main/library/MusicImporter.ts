import { rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import type { MusicTrack } from '@shared/models/editor'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import { trackUrl } from '@shared/models/media'
import type { FfmpegService } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class MusicImportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'MusicImportError'
  }
}

export interface MusicImporterDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
}

/** Longest file taken as music; anything longer is not a soundtrack. */
const MAX_MUSIC_MS = 4 * 60 * 60 * 1000

/**
 * Brings a music file into a session as its `music.m4a` track — AAC in MP4,
 * like the recorded audio, copied when it already is AAC and re-encoded
 * otherwise. The original file is never touched. A session has one music
 * track: choosing another file replaces it whole; the project only keeps
 * how it plays.
 */
export class MusicImporter {
  constructor(private readonly deps: MusicImporterDeps) {}

  /** Imports one file into the session and returns the track as the editor sees it. */
  async import(sessionId: string, filePath: string): Promise<MusicTrack> {
    const { ffmpeg, sessions, logger } = this.deps
    const manifest = await sessions.read(sessionId)
    if (!manifest) throw new MusicImportError(appError('invalid-state', 'session not found'))

    let probe
    try {
      probe = await ffmpeg.probeMedia(filePath)
    } catch (error) {
      throw new MusicImportError(appError('music-unsupported', String(error)))
    }
    if (!probe.audio) throw new MusicImportError(appError('music-unsupported', `no audio stream in ${path.basename(filePath)}`))
    if (probe.durationMs > MAX_MUSIC_MS) throw new MusicImportError(appError('music-unsupported', 'file too long for music'))

    const outputPath = sessions.trackPathOf(sessionId, 'music')
    const partialPath = `${outputPath}.part`
    const name = path.basename(filePath)
    logger.info('importing music', { sessionId, file: filePath, codec: probe.audio.codec })
    try {
      await ffmpeg.writeAudioTrack(filePath, partialPath, probe.audio.codec === 'aac')
      const [size, durationMs] = await Promise.all([stat(partialPath), ffmpeg.durationOf(partialPath)])
      // The file takes its name only once whole, so a failure never leaves a broken track behind.
      await rename(partialPath, outputPath)
      const music = { file: SESSION_FILES.music, sizeBytes: size.size, durationMs: Math.round(durationMs), name }
      await sessions.write({ ...manifest, assets: { ...manifest.assets, music } })
      logger.info('music imported', { sessionId, durationMs: music.durationMs })
      return { url: trackUrl(sessionId, 'music'), durationMs: music.durationMs, name }
    } catch (error) {
      await rm(partialPath, { force: true })
      logger.error('music import failed', { sessionId, file: filePath, error: String(error) })
      throw error instanceof MusicImportError ? error : new MusicImportError(appError('music-failed', String(error)))
    }
  }

  /** Removes the session's music track and forgets it in the manifest. */
  async remove(sessionId: string): Promise<void> {
    const { sessions } = this.deps
    const manifest = await sessions.read(sessionId)
    if (!manifest) throw new MusicImportError(appError('invalid-state', 'session not found'))
    await rm(sessions.trackPathOf(sessionId, 'music'), { force: true })
    const assets = { ...manifest.assets }
    delete assets.music
    await sessions.write({ ...manifest, assets })
  }
}

export function toMusicAppError(error: unknown): AppError {
  return error instanceof MusicImportError ? error.appError : appError('music-failed', String(error))
}
