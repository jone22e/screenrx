import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeWords } from '@engine/captions/captionCues'
import { SESSION_FILES } from '@shared/config/recording'
import type {
  CaptionLocaleId,
  LocaleDetection,
  Transcript,
  TranscriptTrack,
  TranscriptWord,
  TranscriptionProgress,
  TranscriptionRequest,
  TranscriptionStage
} from '@shared/models/captions'
import { TRANSCRIPT_SCHEMA_VERSION, isCaptionLocale, parseTranscriptWord } from '@shared/models/captions'
import type { AppError, AppErrorCode } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import { JsonLineDecoder } from '../capture/macos/JsonLineDecoder'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'
import { transcriptPreview } from '@engine/captions/transcriptPreview'
import type { SessionStore } from '../recording/SessionStore'

export class TranscriptionError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'TranscriptionError'
  }
}

export interface TranscriptionServiceOptions {
  /** The native transcriber, or `null` on a platform that has none. */
  binaryPath: string | null
  sessions: SessionStore
  logger: Logger
  onProgress: (progress: TranscriptionProgress) => void
  /** Cuts the first `endMs` of a track into `outputPath`, for detecting the language; absent in tests. */
  clip?: (inputPath: string, outputPath: string, endMs: number) => Promise<void>
}

/** How much of the recording is listened to when telling the language. */
const DETECTION_CLIP_MS = 20_000

const STAGES: readonly TranscriptionStage[] = ['preparing', 'downloading', 'transcribing']

/** How the transcriber's own failure codes are shown to the user. */
const HELPER_ERROR_CODES: Record<string, AppErrorCode> = {
  'unsupported-os': 'transcription-unavailable',
  'unsupported-locale': 'transcription-unavailable'
}

interface Run {
  sessionId: string
  child: ChildProcess
  cancelled: boolean
}

/**
 * Speech-to-text for captions. The work is done by a native helper that
 * recognizes speech on this machine — the audio is never uploaded — and the
 * result is stored in the session as `transcript.json`. The audio track
 * itself is only read.
 */
export class TranscriptionService {
  private running: Run | null = null

  constructor(private readonly options: TranscriptionServiceOptions) {}

  /** Transcribes one audio track of a session and stores the result. One at a time. */
  async generate(sessionId: string, request: TranscriptionRequest): Promise<Transcript> {
    const { binaryPath, sessions, logger } = this.options
    if (this.running) throw new TranscriptionError(appError('transcription-busy'))
    if (!binaryPath) throw new TranscriptionError(appError('transcription-unavailable', 'no transcriber'))

    const manifest = await sessions.read(sessionId)
    if (!manifest?.assets[request.track]) {
      throw new TranscriptionError(appError('transcription-failed', `session has no ${request.track} track`))
    }

    const startedAt = Date.now()
    const audioPath = sessions.trackPathOf(sessionId, request.track)
    const words = normalizeWords(await this.run(binaryPath, sessionId, audioPath, request.locale))
    const transcript: Transcript = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      locale: request.locale,
      track: request.track,
      words
    }
    await writeJsonAtomic(path.join(sessions.directoryOf(sessionId), SESSION_FILES.transcript), transcript)
    // The library shows and searches the start of what was said, and suggests a name from it.
    try {
      await sessions.setTranscriptPreview(sessionId, transcriptPreview(words))
    } catch (error) {
      logger.warn('could not keep the transcript preview', { sessionId, error: String(error) })
    }
    logger.info('transcribed', {
      sessionId,
      track: request.track,
      locale: request.locale,
      words: words.length,
      elapsedMs: Date.now() - startedAt
    })
    return transcript
  }

  /**
   * Which of `candidates` the recording is spoken in, judged from its first
   * seconds. Only languages whose model is already on this Mac are tried.
   */
  async detectLocale(sessionId: string, track: TranscriptTrack, candidates: readonly CaptionLocaleId[]): Promise<LocaleDetection> {
    const { binaryPath, sessions, logger, clip } = this.options
    if (this.running) throw new TranscriptionError(appError('transcription-busy'))
    if (!binaryPath) throw new TranscriptionError(appError('transcription-unavailable', 'no transcriber'))
    const manifest = await sessions.read(sessionId)
    if (!manifest?.assets[track]) throw new TranscriptionError(appError('transcription-failed', `session has no ${track} track`))

    const audioPath = sessions.trackPathOf(sessionId, track)
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'screenrx-detect-'))
    const startedAt = Date.now()
    try {
      let input = audioPath
      if (clip) {
        input = path.join(workDir, 'clip.wav')
        await clip(audioPath, input, DETECTION_CLIP_MS)
      }
      const detection = await this.runDetection(binaryPath, sessionId, input, candidates)
      logger.info('language detected', { sessionId, locale: detection.locale, candidates: detection.candidates, elapsedMs: Date.now() - startedAt })
      return detection
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  /** Stops the transcription in progress, if any. */
  cancel(): void {
    if (!this.running) return
    this.running.cancelled = true
    this.running.child.kill('SIGTERM')
  }

  private runDetection(
    binaryPath: string,
    sessionId: string,
    audioPath: string,
    candidates: readonly CaptionLocaleId[]
  ): Promise<LocaleDetection> {
    const { logger } = this.options
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, ['--detect', '--input', audioPath, '--locales', candidates.join(',')], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const run: Run = { sessionId, child, cancelled: false }
      this.running = run
      const detection: LocaleDetection = { locale: null, candidates: [] }
      let finished = false
      let failure: AppError | null = null
      let stderr = ''

      const decoder = new JsonLineDecoder(
        (message) => {
          if (typeof message !== 'object' || message === null) return
          const { type, locale, installed, confidence, count, code, detail } = message as Record<string, unknown>
          if (type === 'candidate' && isCaptionLocale(locale)) {
            detection.candidates.push({
              locale,
              installed: installed === true,
              confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0,
              words: typeof count === 'number' ? count : 0
            })
          } else if (type === 'detected') {
            detection.locale = isCaptionLocale(locale) ? locale : null
          } else if (type === 'done') {
            finished = true
          } else if (type === 'error') {
            const helperCode = typeof code === 'string' ? code : 'failed'
            failure = appError(HELPER_ERROR_CODES[helperCode] ?? 'transcription-failed', `${helperCode}: ${typeof detail === 'string' ? detail : ''}`)
          }
        },
        (reason) => logger.warn('transcriber sent an invalid line', { reason })
      )
      child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      const settle = (error: AppError | null): void => {
        if (this.running !== run) return
        this.running = null
        if (error) reject(new TranscriptionError(error))
        else resolve(detection)
      }
      child.once('error', (error) => settle(appError('transcription-unavailable', String(error))))
      child.once('close', (exitCode, signal) => {
        if (run.cancelled) settle(appError('transcription-cancelled'))
        else if (failure) settle(failure)
        else if (exitCode === 0 && finished) settle(null)
        else settle(appError('transcription-failed', `exit ${exitCode ?? signal ?? '?'}: ${stderr.trim()}`))
      })
    })
  }

  private run(binaryPath: string, sessionId: string, audioPath: string, locale: string): Promise<TranscriptWord[]> {
    const { logger, onProgress } = this.options
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, ['--input', audioPath, '--locale', locale], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const run: Run = { sessionId, child, cancelled: false }
      this.running = run

      const words: TranscriptWord[] = []
      let stage: TranscriptionStage = 'preparing'
      let finished = false
      let failure: AppError | null = null
      let stderr = ''

      const decoder = new JsonLineDecoder(
        (message) => {
          if (typeof message !== 'object' || message === null) return
          const { type, state, fraction, code, detail } = message as Record<string, unknown>
          if (type === 'status' && STAGES.includes(state as TranscriptionStage)) {
            stage = state as TranscriptionStage
            onProgress({ sessionId, stage, fraction: 0 })
          } else if (type === 'words') {
            const batch = (message as { words?: unknown }).words
            for (const entry of Array.isArray(batch) ? batch : []) {
              const word = parseTranscriptWord(entry)
              if (word) words.push(word)
            }
            onProgress({
              sessionId,
              stage,
              fraction: typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0
            })
          } else if (type === 'done') {
            finished = true
          } else if (type === 'error') {
            const helperCode = typeof code === 'string' ? code : 'failed'
            failure = appError(
              HELPER_ERROR_CODES[helperCode] ?? 'transcription-failed',
              `${helperCode}: ${typeof detail === 'string' ? detail : ''}`
            )
          }
        },
        (reason) => logger.warn('transcriber sent an invalid line', { reason })
      )
      child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })

      const settle = (error: AppError | null): void => {
        if (this.running !== run) return
        this.running = null
        if (error) reject(new TranscriptionError(error))
        else resolve(words)
      }

      child.once('error', (error) => {
        logger.error('transcriber could not start', { error: String(error) })
        settle(appError('transcription-unavailable', String(error)))
      })
      child.once('close', (exitCode, signal) => {
        if (run.cancelled) settle(appError('transcription-cancelled'))
        else if (failure) settle(failure)
        else if (exitCode === 0 && finished) settle(null)
        else settle(appError('transcription-failed', `exit ${exitCode ?? signal ?? '?'}: ${stderr.trim()}`))
      })
    })
  }
}
