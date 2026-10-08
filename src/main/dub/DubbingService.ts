import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DUB_CONFIG } from '@engine/dub/dubConfig'
import { layoutDubClips } from '@engine/dub/dubUnits'
import { VERIFICATION_LOCALES, speechSimilarity } from '@engine/dub/dubVerification'
import { spellNumbers } from '@engine/dub/spellNumbers'
import type { DubProgress, DubRequest, DubStage, DubStatus, DubTrack, DubUnitRequest } from '@shared/models/dub'
import { VOICE_MODEL_DOWNLOAD_BYTES } from '@shared/models/dub'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import { DUB_TRACKS, trackUrl } from '@shared/models/media'
import { transcribeFile } from '../captions/transcribeFile'
import { JsonLineDecoder } from '../capture/macos/JsonLineDecoder'
import type { FfmpegService } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class DubError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'DubError'
  }
}

export interface DubbingServiceOptions {
  /** The voice helper, or `null` where this build has none. */
  helperPath: string | null
  /** The transcriber, used to check what was synthesized; `null` skips the check. */
  transcriberPath: string | null
  /** Where the voice model is kept: the app's own data, not the user's caches. */
  modelsDirectory: string
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
  onProgress: (progress: DubProgress) => void
}

/** Where the helper keeps the model inside the models directory, and how it marks it ready. */
const MODEL_SUBDIRECTORY = path.join('mlx-audio', 'mlx-community_OmniVoice-4bit')
const MODEL_READY_MARKER = '.screenrx-unpacked'
/** The rate the voice model works at; the reference is cut at it. */
const VOICE_SAMPLE_RATE = 24_000
const HELPER_STAGES: readonly DubStage[] = ['downloading', 'unpacking', 'loading', 'synthesizing']
/** Clips listened to at the same time when checking them. */
const VERIFICATION_CONCURRENCY = 4

interface Take {
  path: string
  durationMs: number
  score: number
}

/**
 * Dubbing: the captions of a recording spoken in another language, in the
 * speaker's own voice. The voice is cloned and synthesized on this machine
 * by a native helper; nothing is uploaded. The result is one more audio
 * track of the session (`dub-<language>.m4a`), derived data that can be
 * generated again — the recorded tracks are only read.
 *
 * One thing at a time: preparing the model or generating one dubbing.
 */
export class DubbingService {
  private running: { child: ChildProcess | null; abort: AbortController } | null = null
  private preparing = false

  constructor(private readonly options: DubbingServiceOptions) {}

  async status(): Promise<DubStatus> {
    return {
      available: this.options.helperPath !== null,
      model: this.preparing ? 'preparing' : (await this.modelReady()) ? 'ready' : 'missing',
      modelDownloadBytes: VOICE_MODEL_DOWNLOAD_BYTES
    }
  }

  /** Downloads and unpacks the voice model, once. */
  async prepareModel(): Promise<DubStatus> {
    const helper = this.requireHelper()
    await this.exclusively(async (run) => {
      this.preparing = true
      try {
        await mkdir(this.options.modelsDirectory, { recursive: true })
        await this.runHelper(helper, ['prepare', '--models', this.options.modelsDirectory], run, () => undefined)
      } finally {
        this.preparing = false
      }
    })
    return this.status()
  }

  /** Removes the downloaded voice model. */
  async removeModel(): Promise<DubStatus> {
    if (this.running) throw new DubError(appError('dub-busy'))
    await rm(path.join(this.options.modelsDirectory, MODEL_SUBDIRECTORY), { recursive: true, force: true })
    return this.status()
  }

  /** Synthesizes the dubbing of a session in one language and stores it as a track. */
  async generate(sessionId: string, request: DubRequest): Promise<DubTrack> {
    const helper = this.requireHelper()
    const { sessions, ffmpeg, logger } = this.options
    const manifest = await sessions.read(sessionId)
    const durationMs = manifest?.assets.screen?.durationMs
    if (!manifest?.assets.microphone || durationMs === undefined) {
      throw new DubError(appError('dub-failed', 'the session has no microphone track to learn the voice from'))
    }
    if (!(await this.modelReady())) throw new DubError(appError('dub-model-missing'))

    const startedAt = Date.now()
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'screenrx-dub-'))
    try {
      return await this.exclusively(async (run) => {
        // The voice: a few seconds of the microphone track, with what is said in them.
        const referencePath = path.join(workDir, 'reference.wav')
        const referenceTextPath = path.join(workDir, 'reference.txt')
        await ffmpeg.extractAudioClip(
          sessions.trackPathOf(sessionId, 'microphone'),
          referencePath,
          request.reference.startMs,
          request.reference.endMs,
          VOICE_SAMPLE_RATE
        )
        await writeFile(referenceTextPath, request.reference.text)

        const best = new Map<string, Take>()
        let pending = request.units
        for (let attempt = 1; attempt <= DUB_CONFIG.verification.attempts && pending.length > 0; attempt++) {
          const takes = await this.synthesize(helper, run, {
            workDir,
            attempt,
            units: pending,
            language: request.language,
            referencePath,
            referenceTextPath,
            // Later attempts are a small share of the work: only the first drives the bar.
            report: attempt === 1
          })
          await this.verify(takes, pending, request.language, run.abort.signal)
          for (const [id, take] of takes) {
            const previous = best.get(id)
            if (!previous || take.score > previous.score) best.set(id, take)
          }
          pending = pending.filter((unit) => (best.get(unit.id)?.score ?? 0) < DUB_CONFIG.verification.acceptAt)
          if (this.options.transcriberPath === null) break
        }

        this.report('assembling', 0)
        const placed = layoutDubClips(
          request.units,
          new Map([...best].map(([id, take]) => [id, take.durationMs])),
          durationMs
        )
        const track = DUB_TRACKS[request.language]
        const outputPath = sessions.trackPathOf(sessionId, track)
        const partialPath = `${outputPath}.part`
        await ffmpeg.mixClips(
          placed.map((clip) => ({ path: (best.get(clip.id) as Take).path, startMs: clip.startMs })),
          durationMs,
          partialPath
        )
        await rename(partialPath, outputPath)

        const scores = [...best.values()].map((take) => take.score)
        logger.info('dubbing generated', {
          sessionId,
          language: request.language,
          units: request.units.length,
          placed: placed.length,
          understoodBelowThreshold: pending.length,
          lowestScore: scores.length > 0 ? Math.min(...scores) : null,
          elapsedMs: Date.now() - startedAt
        })
        return { language: request.language, url: trackUrl(sessionId, track) }
      })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  /** Stops whatever is in progress. */
  cancel(): void {
    if (!this.running) return
    this.running.abort.abort()
    this.running.child?.kill('SIGTERM')
  }

  // --- steps -----------------------------------------------------------------

  /** Speaks every unit once and returns the clips, by unit id. */
  private async synthesize(
    helper: string,
    run: NonNullable<DubbingService['running']>,
    job: {
      workDir: string
      attempt: number
      units: readonly DubUnitRequest[]
      language: DubRequest['language']
      referencePath: string
      referenceTextPath: string
      report: boolean
    }
  ): Promise<Map<string, Take>> {
    const jobsPath = path.join(job.workDir, `jobs-${job.attempt}.json`)
    const outputOf = (unit: DubUnitRequest): string => path.join(job.workDir, `${unit.id}-take${job.attempt}.wav`)
    await writeFile(
      jobsPath,
      JSON.stringify(
        job.units.map((unit) => ({
          id: unit.id,
          // Digits would be read in the language the voice was learned from.
          text: spellNumbers(unit.text, job.language),
          output: outputOf(unit),
          maxDurationS: (unit.slotEndMs - unit.startMs) / 1000
        }))
      )
    )

    const takes = new Map<string, Take>()
    await this.runHelper(
      helper,
      [
        'synthesize',
        '--models', this.options.modelsDirectory,
        '--reference', job.referencePath,
        '--reference-text', job.referenceTextPath,
        '--language', job.language,
        '--jobs', jobsPath,
        // A different seed per attempt: the same text spoken again comes out differently.
        '--seed', String(job.attempt)
      ],
      run,
      (id, durationMs) => {
        const unit = job.units.find((candidate) => candidate.id === id)
        // Until it is listened to, a take is assumed fine.
        if (unit) takes.set(id, { path: outputOf(unit), durationMs, score: 1 })
      },
      job.report
    )
    return takes
  }

  /** Listens to each clip with the speech recognizer and scores how much of its text was heard. */
  private async verify(
    takes: Map<string, Take>,
    units: readonly DubUnitRequest[],
    language: DubRequest['language'],
    signal: AbortSignal
  ): Promise<void> {
    const transcriber = this.options.transcriberPath
    if (transcriber === null) return
    this.report('verifying', 0)
    const queue = units.filter((unit) => takes.has(unit.id))
    let checked = 0
    const worker = async (): Promise<void> => {
      for (let unit = queue.shift(); unit !== undefined; unit = queue.shift()) {
        const take = takes.get(unit.id) as Take
        try {
          const heard = await transcribeFile(transcriber, take.path, VERIFICATION_LOCALES[language], signal)
          // The recognizer writes numbers in digits: both sides are compared in words.
          take.score = speechSimilarity(
            spellNumbers(unit.text, language),
            spellNumbers(heard.map((word) => word.text).join(' '), language)
          )
        } catch (error) {
          if (signal.aborted) throw new DubError(appError('dub-cancelled'))
          // A recognizer that cannot run says nothing about the clip: it is kept as it is.
          this.options.logger.warn('could not verify a dubbing clip', { unit: unit.id, error: String(error) })
        }
        checked += 1
        this.report('verifying', checked / Math.max(units.length, 1))
      }
    }
    await Promise.all(Array.from({ length: VERIFICATION_CONCURRENCY }, worker))
  }

  // --- helper process ----------------------------------------------------------

  private runHelper(
    helper: string,
    args: string[],
    run: NonNullable<DubbingService['running']>,
    onItem: (id: string, durationMs: number) => void,
    report = true
  ): Promise<void> {
    const { logger } = this.options
    return new Promise((resolve, reject) => {
      const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      run.child = child
      let stage: DubStage = 'loading'
      let finished = false
      let failure: AppError | null = null
      let stderr = ''

      const decoder = new JsonLineDecoder(
        (message) => {
          if (typeof message !== 'object' || message === null) return
          const { type, state, fraction, id, durationMs, code, detail } = message as Record<string, unknown>
          if (type === 'status' && HELPER_STAGES.includes(state as DubStage)) {
            stage = state as DubStage
            if (report) this.report(stage, 0)
          } else if (type === 'progress' && typeof fraction === 'number' && Number.isFinite(fraction)) {
            if (report) this.report(stage, Math.min(Math.max(fraction, 0), 1))
          } else if (type === 'item' && typeof id === 'string' && typeof durationMs === 'number') {
            onItem(id, durationMs)
          } else if (type === 'done') {
            finished = true
          } else if (type === 'error') {
            const helperCode = typeof code === 'string' ? code : 'failed'
            failure = appError(
              helperCode === 'model-missing'
                ? 'dub-model-missing'
                : helperCode === 'download-failed'
                  ? 'dub-download-failed'
                  : 'dub-failed',
              `${helperCode}: ${typeof detail === 'string' ? detail.slice(0, 500) : ''}`
            )
          }
        },
        // The speech runtime prints notes of its own between the helper's messages.
        () => undefined
      )
      child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      child.once('error', (error) => {
        logger.error('voice helper could not start', { error: String(error) })
        reject(new DubError(appError('dub-unavailable', String(error))))
      })
      child.once('close', (exitCode, signal) => {
        run.child = null
        if (run.abort.signal.aborted) reject(new DubError(appError('dub-cancelled')))
        else if (failure) reject(new DubError(failure))
        else if (exitCode === 0 && finished) resolve()
        else reject(new DubError(appError('dub-failed', `exit ${exitCode ?? signal ?? '?'}: ${stderr.trim().slice(-500)}`)))
      })
    })
  }

  private async exclusively<T>(work: (run: NonNullable<DubbingService['running']>) => Promise<T>): Promise<T> {
    if (this.running) throw new DubError(appError('dub-busy'))
    const run = { child: null, abort: new AbortController() }
    this.running = run
    try {
      return await work(run)
    } finally {
      this.running = null
    }
  }

  private requireHelper(): string {
    if (this.options.helperPath === null) throw new DubError(appError('dub-unavailable', 'no voice helper'))
    return this.options.helperPath
  }

  private async modelReady(): Promise<boolean> {
    try {
      await access(path.join(this.options.modelsDirectory, MODEL_SUBDIRECTORY, MODEL_READY_MARKER))
      return true
    } catch {
      return false
    }
  }

  private report(stage: DubStage, fraction: number): void {
    this.options.onProgress({ stage, fraction })
  }
}
