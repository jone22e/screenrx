import type { VerboseTranscription } from '@engine/captions/whisperWords'
import { parseVerboseTranscription } from '@engine/captions/whisperWords'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { TranscriptionConfig } from '../config'

export class WhisperClientError extends Error {
  constructor(
    readonly appError: AppError,
    /** The service answered that it does not have the model (a self-hosted one, before its first download). */
    readonly modelMissing = false
  ) {
    super(appError.detail ?? appError.code)
    this.name = 'WhisperClientError'
  }
}

export interface WhisperRequest {
  /** A WAV file. */
  wav: Uint8Array
  /** ISO 639-1; `null` lets the service tell the language. */
  language: string | null
  signal?: AbortSignal
  /** Told when the service has to fetch the model before answering. */
  onDownloading?: () => void
}

/** How long a self-hosted service may take to fetch the model. */
const MODEL_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000

/**
 * One call to the audio API that OpenAI, Groq and the self-hosted Whisper
 * servers share (`POST /audio/transcriptions`), asking for the words with
 * their times.
 */
/** Whether the model is there after asking for it: not every service installs on request, and the service may be down. */
export type ModelInstall = 'installed' | 'unsupported' | 'unreachable'

export class WhisperClient {
  private installing: Promise<ModelInstall> | null = null

  constructor(
    private readonly config: Pick<TranscriptionConfig, 'baseUrl' | 'apiKey' | 'model' | 'timeoutSeconds'>,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Asks a self-hosted service (speaches) to fetch the model, so the first
   * transcription does not fail for lack of it. `unsupported` when the service
   * does not install models that way (OpenAI, Groq); one download at a time.
   */
  installModel(): Promise<ModelInstall> {
    this.installing ??= this.requestInstall().finally(() => {
      this.installing = null
    })
    return this.installing
  }

  private async requestInstall(): Promise<ModelInstall> {
    const { baseUrl, model } = this.config
    try {
      const response = await this.fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS)
      })
      await response.text().catch(() => '')
      // Already there counts as installed; a service without the endpoint does not.
      return response.ok || response.status === 409 ? 'installed' : 'unsupported'
    } catch {
      return 'unreachable'
    }
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}
  }

  async transcribe(request: WhisperRequest): Promise<VerboseTranscription> {
    try {
      return await this.request(request)
    } catch (error) {
      if (!(error instanceof WhisperClientError) || !error.modelMissing) throw error
      // The self-hosted service has no model yet: fetch it, then ask again.
      request.onDownloading?.()
      if ((await this.installModel()) !== 'installed') throw error
      return this.request(request)
    }
  }

  private async request({ wav, language, signal }: WhisperRequest): Promise<VerboseTranscription> {
    const { baseUrl, model, timeoutSeconds } = this.config
    const body = new FormData()
    body.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    body.set('model', model)
    body.set('response_format', 'verbose_json')
    body.append('timestamp_granularities[]', 'word')
    body.append('timestamp_granularities[]', 'segment')
    if (language) body.set('language', language)

    const headers = this.headers()
    const timeout = AbortSignal.timeout(timeoutSeconds * 1000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers, body, signal: combined })
    } catch (error) {
      if (signal?.aborted) throw new WhisperClientError(appError('transcription-cancelled'))
      if (timeout.aborted) throw new WhisperClientError(appError('transcription-failed', `timed out after ${timeoutSeconds}s`))
      throw new WhisperClientError(appError('transcription-server-unreachable', String(error)))
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 500)
      if (response.status === 413) throw new WhisperClientError(appError('transcription-too-long', text))
      const modelMissing = response.status === 404 && /model/i.test(text) && /not (installed|found|available)/i.test(text)
      throw new WhisperClientError(appError('transcription-failed', `${response.status} ${text}`), modelMissing)
    }
    const transcription = parseVerboseTranscription(await response.json().catch(() => null))
    if (!transcription) throw new WhisperClientError(appError('transcription-failed', 'unexpected answer from the service'))
    return transcription
  }
}
