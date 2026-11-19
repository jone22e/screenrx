import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { TRANSCRIPTION_API_PATH } from '@shared/models/transcriptionApi'
import type { Logger } from '../main/logging/logger'
import type { ServerConfig } from './config'
import { serveStatic } from './static'
import { TranscriptionRoute } from './transcription/transcriptionRoute'

export interface AppOptions {
  config: ServerConfig
  logger: Logger
  /** Stands in for the network in tests. */
  fetchImpl?: typeof fetch | undefined
}

/**
 * The web editor's server: the page as static files, a health check, and
 * the transcription API when a service is set up. Everything else about the
 * editing stays in the browser.
 */
export function createApp({ config, logger, fetchImpl }: AppOptions): RequestListener {
  const transcription = config.transcription ? new TranscriptionRoute(config.transcription, logger, fetchImpl) : null
  void transcription?.warmUp()

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('ok')
      return
    }
    if (url.pathname === TRANSCRIPTION_API_PATH) {
      if (request.method === 'GET') {
        const info = transcription?.info() ?? { transcription: false, maxMinutes: 0 }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(info))
        return
      }
      if (request.method === 'POST') {
        if (!transcription) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('transcription is not set up on this server')
          return
        }
        await transcription.handle(request, response, url)
        return
      }
      response.writeHead(405, { Allow: 'GET, POST' }).end()
      return
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    await serveStatic(config.webDir, request, response, url.pathname)
  }

  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.error('request failed', { url: request.url, error: String(error) })
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end()
    })
  }
}
