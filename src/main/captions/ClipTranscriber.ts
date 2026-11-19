import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import type { TranscriptWord } from '@shared/models/captions'
import { parseTranscriptWord } from '@shared/models/captions'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import { isSafeFileName, resolveInside } from '../filesystem/safePaths'
import type { FfmpegService } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export interface ClipTranscriberDeps {
  /** Transcribes one audio file (the native transcriber, on this Mac). */
  transcribe: (audioPath: string, locale: string) => Promise<TranscriptWord[]>
  ffmpeg: Pick<FfmpegService, 'extractAudioClip'>
  sessions: SessionStore
  logger: Logger
}

/**
 * What is said in a clip of the session (the second video: a reaction, a
 * commentary), on the clip's own clock. Transcribed once on this Mac and kept
 * next to the clip (`<file>.words.json`), so the editing team can read it.
 */
export class ClipTranscriber {
  constructor(private readonly deps: ClipTranscriberDeps) {}

  /** `null` when the clip has no sound or the transcriber cannot run here. */
  async wordsOf(sessionId: string, file: string, durationMs: number, locale: string): Promise<TranscriptWord[] | null> {
    const { sessions, ffmpeg, logger } = this.deps
    if (!isSafeFileName(file)) return null
    const assets = path.join(sessions.directoryOf(sessionId), SESSION_FILES.assets)
    const clipPath = resolveInside(assets, file)
    const cachePath = resolveInside(assets, `${file}.words.json`)
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as { locale?: unknown; words?: unknown }
      if (cached.locale === locale && Array.isArray(cached.words)) return cached.words.map(parseTranscriptWord).filter((word): word is TranscriptWord => word !== null)
    } catch {
      // Not transcribed yet.
    }
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'screenrx-clip-words-'))
    const startedAt = Date.now()
    try {
      const wavPath = path.join(workDir, 'clip.wav')
      await ffmpeg.extractAudioClip(clipPath, wavPath, 0, durationMs, 16_000)
      const words = await this.deps.transcribe(wavPath, locale)
      await writeJsonAtomic(cachePath, { locale, words })
      logger.info('clip transcribed', { sessionId, file, words: words.length, elapsedMs: Date.now() - startedAt })
      return words
    } catch (error) {
      logger.warn('clip not transcribed', { sessionId, file, error: String(error) })
      return null
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}

/** The clip's words placed on the recording's clock, piece by piece: only what each piece shows of the clip. */
export function wordsOnRecordingClock(
  words: readonly TranscriptWord[],
  pieces: ReadonlyArray<{ startMs: number; endMs: number; offsetMs: number }>
): TranscriptWord[] {
  const placed: TranscriptWord[] = []
  for (const piece of pieces) {
    const from = piece.offsetMs
    const to = piece.offsetMs + (piece.endMs - piece.startMs)
    for (const word of words) {
      if (word.startMs < from || word.startMs >= to) continue
      const shift = piece.startMs - piece.offsetMs
      placed.push({ text: word.text, startMs: word.startMs + shift, endMs: Math.min(word.endMs, to) + shift })
    }
  }
  return placed.sort((a, b) => a.startMs - b.startMs)
}
