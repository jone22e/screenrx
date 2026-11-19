import type { IncomingMessage, ServerResponse } from 'node:http'
import { decodeWav16, encodeWav16, splitAtQuiet } from '@engine/audio/wav'
import { normalizeWords } from '@engine/captions/captionCues'
import { whisperLanguageOf, wordsFromTranscription } from '@engine/captions/whisperWords'
import type { TranscriptWord } from '@shared/models/captions'
import { isCaptionLocale } from '@shared/models/captions'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { TranscriptionEvent, TranscriptionServiceInfo } from '@shared/models/transcriptionApi'
import type { Logger } from '../../main/logging/logger'
import type { TranscriptionConfig } from '../config'
import { WhisperClient, WhisperClientError } from './whisperClient'

/** How much of the audio is listened to when telling the language. */
const DETECTION_SECONDS = 20
/** How often the page hears how far the pieces in flight are. */
const PROGRESS_TICK_MS = 1000
/** Audio seconds transcribed per second, assumed until a piece has been timed: real time, so the bar does not stall early. */
const ASSUMED_SPEED = 1
/** A piece in flight is never shown as more done than this, since its real end is unknown. */
const PIECE_CAP = 0.92

/**
 * How far a transcription is, counting the pieces done and estimating the ones
 * in flight from how long they have been out and how fast the service has
 * proved to be. Never goes backwards.
 */
export class PieceProgress {
  private readonly startedAt: Array<number | null>
  private readonly done: boolean[]
  private speed = ASSUMED_SPEED
  private timed = 0
  private shown = 0

  constructor(
    private readonly seconds: readonly number[],
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = seconds.map(() => null)
    this.done = seconds.map(() => false)
  }

  start(index: number): void {
    this.startedAt[index] = this.now()
  }

  finish(index: number): void {
    this.done[index] = true
    const startedAt = this.startedAt[index]
    const elapsed = startedAt === null || startedAt === undefined ? 0 : (this.now() - startedAt) / 1000
    if (elapsed > 0) {
      // Pieces run beside each other, so each one's own speed is what the next can expect.
      const observed = (this.seconds[index] ?? 0) / elapsed
      this.speed = this.timed === 0 ? observed : (this.speed * this.timed + observed) / (this.timed + 1)
      this.timed++
    }
  }

  fraction(): number {
    const total = this.seconds.reduce((sum, seconds) => sum + seconds, 0)
    if (total <= 0) return 1
    let transcribed = 0
    for (const [index, seconds] of this.seconds.entries()) {
      const startedAt = this.startedAt[index]
      if (this.done[index]) transcribed += seconds
      else if (startedAt !== null && startedAt !== undefined) {
        const elapsed = (this.now() - startedAt) / 1000
        transcribed += Math.min(seconds * PIECE_CAP, elapsed * this.speed)
      }
    }
    this.shown = Math.max(this.shown, Math.min(1, transcribed / total))
    return this.shown
  }
}
/** Room for the WAV header and a little slack above the longest audio allowed. */
const BODY_SLACK_BYTES = 1024 * 1024

/** Lets at most `limit` pieces of audio be in flight at once, over all requests. */
class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await work()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

/**
 * `GET` says whether transcription is on; `POST` takes a mono 16-bit WAV and
 * answers JSON lines: progress while the pieces are transcribed, then the
 * words (`done`) or an `error`. Closing the request stops the work.
 */
export class TranscriptionRoute {
  private readonly client: WhisperClient
  private readonly slots: Semaphore

  constructor(
    private readonly config: TranscriptionConfig,
    private readonly logger: Logger,
    fetchImpl?: typeof fetch
  ) {
    this.client = new WhisperClient(config, fetchImpl)
    this.slots = new Semaphore(config.concurrency)
  }

  info(): TranscriptionServiceInfo {
    return { transcription: true, maxMinutes: this.config.maxMinutes }
  }

  /** Has a self-hosted service fetch the model now, so the first user does not wait for it. */
  async warmUp(): Promise<void> {
    const startedAt = Date.now()
    const outcome = await this.client.installModel()
    const data = { model: this.config.model, elapsedMs: Date.now() - startedAt }
    if (outcome === 'installed') this.logger.info('model ready', data)
    else if (outcome === 'unreachable') this.logger.warn('the transcription service did not answer; the model will be asked for on first use', data)
    else this.logger.info('the service installs no models on request; the model is expected to be there', data)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const mode = url.searchParams.get('mode') === 'detect' ? 'detect' : 'transcribe'
    const locale = url.searchParams.get('locale')
    let language: string | null = null
    if (mode === 'transcribe') {
      if (!isCaptionLocale(locale)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('locale')
        return
      }
      language = whisperLanguageOf(locale)
    }
    const maxBytes = this.config.maxMinutes * 60 * 48_000 * 2 + BODY_SLACK_BYTES
    const body = await readBody(request, maxBytes)
    if (body === null) {
      response.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }).end('audio too long')
      return
    }
    const wav = decodeWav16(body)
    if (!wav || wav.channels !== 1 || wav.sampleRate < 8000) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('mono 16-bit WAV expected')
      return
    }

    const aborter = new AbortController()
    request.once('close', () => aborter.abort())
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Reverse proxies would otherwise hold the lines until the end.
      'X-Accel-Buffering': 'no'
    })
    const send = (event: TranscriptionEvent): void => {
      if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`)
    }
    const startedAt = Date.now()
    const durationSec = wav.samples.length / wav.sampleRate
    try {
      if (durationSec > this.config.maxMinutes * 60) throw new WhisperClientError(appError('transcription-too-long'))
      send({ type: 'progress', fraction: 0 })
      const result =
        language === null
          ? await this.detect(wav.samples, wav.sampleRate, aborter.signal)
          : await this.transcribe(wav.samples, wav.sampleRate, language, aborter.signal, send)
      send({ type: 'done', words: result.words, language: result.language })
      this.logger.info(mode === 'detect' ? 'language detected' : 'transcribed', {
        seconds: Math.round(durationSec),
        words: result.words.length,
        language: result.language,
        elapsedMs: Date.now() - startedAt
      })
    } catch (error) {
      const failure = errorOf(error, aborter.signal.aborted)
      if (failure.code !== 'transcription-cancelled') this.logger.warn('transcription failed', { code: failure.code, detail: failure.detail })
      send(failure.detail === undefined ? { type: 'error', code: failure.code } : { type: 'error', code: failure.code, detail: failure.detail })
    } finally {
      response.end()
    }
  }

  private async transcribe(
    samples: Int16Array,
    sampleRate: number,
    language: string,
    signal: AbortSignal,
    send: (event: TranscriptionEvent) => void
  ): Promise<{ words: TranscriptWord[]; language: string | null }> {
    const pieces = splitAtQuiet(samples, sampleRate, this.config.chunkMinutes * 60)
    const results: TranscriptWord[][] = pieces.map(() => [])
    let heard: string | null = null
    // The pieces go out together, as many at once as the slots allow; one failing stops the rest.
    const stopper = new AbortController()
    const pieceSignal = AbortSignal.any([signal, stopper.signal])
    const onDownloading = (): void => send({ type: 'progress', fraction: 0, stage: 'downloading' })
    const progress = new PieceProgress(pieces.map((piece) => piece.samples.length / sampleRate))
    const tick = setInterval(() => send({ type: 'progress', fraction: progress.fraction(), stage: 'transcribing' }), PROGRESS_TICK_MS)
    try {
      await Promise.all(
        pieces.map((piece, index) =>
          this.slots.run(async () => {
            if (pieceSignal.aborted) return
            progress.start(index)
            const transcription = await this.client.transcribe({ wav: encodeWav16(piece.samples, sampleRate), language, signal: pieceSignal, onDownloading })
            results[index] = wordsFromTranscription(transcription, piece.startMs)
            heard ??= transcription.language
            progress.finish(index)
            send({ type: 'progress', fraction: progress.fraction(), stage: 'transcribing' })
          })
        )
      )
    } catch (error) {
      stopper.abort()
      throw error
    } finally {
      clearInterval(tick)
    }
    return { words: normalizeWords(results.flat()), language: heard }
  }

  private async detect(samples: Int16Array, sampleRate: number, signal: AbortSignal): Promise<{ words: TranscriptWord[]; language: string | null }> {
    const clip = samples.subarray(0, Math.min(samples.length, DETECTION_SECONDS * sampleRate))
    const transcription = await this.slots.run(() => this.client.transcribe({ wav: encodeWav16(clip, sampleRate), language: null, signal }))
    return { words: normalizeWords(wordsFromTranscription(transcription)), language: transcription.language }
  }
}

/** The whole request body, or `null` once it passes `maxBytes`. */
function readBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      request.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        request.removeAllListeners('data')
        request.resume()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

function errorOf(error: unknown, aborted: boolean): AppError {
  if (aborted) return appError('transcription-cancelled')
  if (error instanceof WhisperClientError) return error.appError
  return appError('transcription-failed', String(error))
}
