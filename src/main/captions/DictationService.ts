import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { Logger } from '../logging/logger'
import { transcribeFile } from './transcribeFile'

export class DictationError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'DictationError'
  }
}

export interface DictationServiceOptions {
  /** The native transcriber; `null` on a platform without one. */
  binaryPath: string | null
  /** The language dictated. */
  locale: string
  logger: Logger
}

/** 16 kHz mono WAV: this many bytes is about twenty minutes of speech. */
const MAX_WAV_BYTES = 40 * 1024 * 1024

/**
 * Turns a dictation recorded in the renderer — a short WAV — into text with
 * the native transcriber, on this Mac. The audio is written to a temporary
 * file for the transcriber and deleted right after; nothing is kept.
 */
export class DictationService {
  constructor(private readonly options: DictationServiceOptions) {}

  async transcribe(wav: Uint8Array): Promise<string> {
    const { binaryPath, locale, logger } = this.options
    if (binaryPath === null) throw new DictationError(appError('transcription-unavailable', 'no transcriber'))
    if (wav.byteLength === 0) throw new DictationError(appError('transcription-failed', 'empty recording'))
    if (wav.byteLength > MAX_WAV_BYTES) throw new DictationError(appError('transcription-failed', 'recording too long'))

    const directory = await mkdtemp(path.join(os.tmpdir(), 'screenrx-dictation-'))
    const file = path.join(directory, 'dictation.wav')
    const startedAt = Date.now()
    try {
      await writeFile(file, wav)
      const words = await transcribeFile(binaryPath, file, locale)
      const text = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim()
      logger.info('dictation transcribed', { bytes: wav.byteLength, words: words.length, elapsedMs: Date.now() - startedAt })
      if (text === '') throw new DictationError(appError('transcription-failed', 'no speech heard'))
      return text
    } catch (error) {
      if (error instanceof DictationError) throw error
      const detail = String((error as Error)?.message ?? error)
      logger.warn('dictation failed', { error: detail })
      throw new DictationError(appError(/unsupported-os|unsupported-locale/.test(detail) ? 'transcription-unavailable' : 'transcription-failed', detail))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
