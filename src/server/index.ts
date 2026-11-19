import { createServer } from 'node:http'
import { addLogSink, consoleSink, createLogger } from '../main/logging/logger'
import { createApp } from './app'
import { configFromEnv } from './config'

/**
 * `node out/server/index.mjs`: serves the web editor and, when
 * SCREENRX_TRANSCRIPTION_URL is set, transcribes speech through that
 * service. See docs/ARCHITECTURE.md, "Editor web".
 */
addLogSink(consoleSink())
const logger = createLogger('server')
const config = configFromEnv(process.env, process.cwd())

const server = createServer(createApp({ config, logger }))
// Uploads of long audio take a while to arrive; transcription takes a while to answer.
server.requestTimeout = 60 * 60 * 1000
server.headersTimeout = 60 * 1000
server.listen(config.port, config.host, () => {
  logger.info('listening', {
    host: config.host,
    port: config.port,
    webDir: config.webDir,
    transcription: config.transcription ? { baseUrl: config.transcription.baseUrl, model: config.transcription.model, maxMinutes: config.transcription.maxMinutes } : null
  })
})

const stop = (signal: string): void => {
  logger.info('stopping', { signal })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
