import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogData = Record<string, unknown>

export interface LogEntry {
  time: Date
  level: LogLevel
  scope: string
  message: string
  data?: LogData
}

export type LogSink = (entry: LogEntry) => void

/** Scoped structured logger: `[recording] started {"sessionId":"…"}`. */
export interface Logger {
  debug(message: string, data?: LogData): void
  info(message: string, data?: LogData): void
  warn(message: string, data?: LogData): void
  error(message: string, data?: LogData): void
}

const sinks = new Set<LogSink>()

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

export function writeLog(entry: LogEntry): void {
  for (const sink of sinks) sink(entry)
}

export function createLogger(scope: string): Logger {
  const log =
    (level: LogLevel) =>
    (message: string, data?: LogData): void =>
      writeLog(data === undefined ? { time: new Date(), level, scope, message } : { time: new Date(), level, scope, message, data })
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }
}

export function formatLogEntry(entry: LogEntry): string {
  const data = entry.data && Object.keys(entry.data).length > 0 ? ` ${safeStringify(entry.data)}` : ''
  const level = entry.level.toUpperCase().padEnd(5)
  return `${entry.time.toISOString()} ${level} [${entry.scope}] ${entry.message}${data}`
}

function safeStringify(data: LogData): string {
  try {
    return JSON.stringify(data, (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message } : value
    )
  } catch {
    return '[unserializable]'
  }
}

export function consoleSink(): LogSink {
  return (entry) => {
    const stream = entry.level === 'error' || entry.level === 'warn' ? process.stderr : process.stdout
    stream.write(`${formatLogEntry(entry)}\n`)
  }
}

export function fileSink(filePath: string): LogSink {
  mkdirSync(dirname(filePath), { recursive: true })
  const stream = createWriteStream(filePath, { flags: 'a' })
  // Logging must never take the app down (e.g. when the disk is full).
  stream.on('error', () => undefined)
  return (entry) => {
    stream.write(`${formatLogEntry(entry)}\n`)
  }
}
