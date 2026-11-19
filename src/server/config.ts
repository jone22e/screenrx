import path from 'node:path'

/**
 * How the web server is set up, from the environment. Only the page is
 * served when no transcription service is named.
 */
export interface ServerConfig {
  host: string
  port: number
  /** The built page (`npm run build:web`). */
  webDir: string
  transcription: TranscriptionConfig | null
}

export interface TranscriptionConfig {
  /** Base of an OpenAI-compatible audio API, e.g. `https://api.openai.com/v1` or `http://speaches:8000/v1`. */
  baseUrl: string
  apiKey: string | null
  model: string
  /** The longest audio accepted. */
  maxMinutes: number
  /** Audio is sent in pieces of at most this long: progress moves a piece at a time, and the services cap each upload. */
  chunkMinutes: number
  /** How many pieces are sent at once, over all requests. */
  concurrency: number
  /** How long one piece may take. */
  timeoutSeconds: number
}

const number = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined || value === '' ? NaN : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

export function configFromEnv(env: NodeJS.ProcessEnv, cwd: string): ServerConfig {
  const baseUrl = env.SCREENRX_TRANSCRIPTION_URL?.trim().replace(/\/+$/, '')
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: number(env.PORT, 8080, 1, 65535),
    webDir: path.resolve(cwd, env.SCREENRX_WEB_DIR?.trim() || 'out/web'),
    transcription: baseUrl
      ? {
          baseUrl,
          apiKey: env.SCREENRX_TRANSCRIPTION_KEY?.trim() || null,
          model: env.SCREENRX_TRANSCRIPTION_MODEL?.trim() || 'whisper-1',
          maxMinutes: number(env.SCREENRX_TRANSCRIPTION_MAX_MINUTES, 120, 1, 24 * 60),
          chunkMinutes: number(env.SCREENRX_TRANSCRIPTION_CHUNK_MINUTES, 1, 1, 60),
          concurrency: number(env.SCREENRX_TRANSCRIPTION_CONCURRENCY, 2, 1, 32),
          timeoutSeconds: number(env.SCREENRX_TRANSCRIPTION_TIMEOUT_SECONDS, 300, 10, 3600)
        }
      : null
  }
}
