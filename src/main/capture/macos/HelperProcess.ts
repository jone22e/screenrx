import type { Readable, Writable } from 'node:stream'
import type { Unsubscribe } from '@shared/ipc/contract'
import type { Logger } from '../../logging/logger'
import { createLogger } from '../../logging/logger'
import { JsonLineDecoder } from './JsonLineDecoder'
import type { HelperErrorPayload, HelperLog, HelperMethod } from './helperProtocol'
import { parseHelperMessage } from './helperProtocol'

/** The part of `ChildProcess` the client relies on; lets tests supply a fake. */
export interface HelperChild {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

/** The helper answered the request with an error. */
export class HelperRequestError extends Error {
  constructor(readonly payload: HelperErrorPayload) {
    super(`${payload.code}: ${payload.message}`)
    this.name = 'HelperRequestError'
  }
}

export type HelperExitKind = 'spawn-failed' | 'crashed' | 'shut-down'

/** The helper is gone: it could not be spawned, crashed, or was shut down. */
export class HelperExitedError extends Error {
  constructor(
    readonly kind: HelperExitKind,
    reason: string
  ) {
    super(`Capture helper ${kind}: ${reason}`)
    this.name = 'HelperExitedError'
  }
}

export class HelperTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Capture helper did not answer ${method} within ${timeoutMs} ms`)
    this.name = 'HelperTimeoutError'
  }
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** How long the helper gets to finalize a recording and exit before it is killed. */
const GRACEFUL_EXIT_TIMEOUT_MS = 10_000

/**
 * Client for the native capture helper: spawns it on demand, correlates
 * JSON-lines requests with their responses, and reports events and exits.
 */
export class HelperProcess {
  private child: HelperChild | null = null
  private exited: Promise<void> = Promise.resolve()
  private nextRequestId = 1
  private spawnCount = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(name: string, payload: unknown) => void>()
  private readonly exitListeners = new Set<(expected: boolean) => void>()
  private readonly helperLoggers = new Map<string, Logger>()

  constructor(
    private readonly spawnHelper: () => HelperChild,
    private readonly logger: Logger
  ) {}

  /** Increments every time a new helper process is spawned. */
  get generation(): number {
    return this.spawnCount
  }

  get isRunning(): boolean {
    return this.child !== null
  }

  request<Result>(method: HelperMethod, params: unknown, timeoutMs: number): Promise<Result> {
    let child: HelperChild
    try {
      child = this.ensureStarted()
    } catch (error) {
      return Promise.reject(new HelperExitedError('spawn-failed', String(error)))
    }

    const id = String(this.nextRequestId++)
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HelperTimeoutError(method, timeoutMs))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (result) => resolve(result as Result),
        reject,
        timer
      })
      const message = params === undefined ? { id, method } : { id, method, params }
      child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  onEvent(listener: (name: string, payload: unknown) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** `expected` is false when the helper died without being asked to stop. */
  onExit(listener: (expected: boolean) => void): Unsubscribe {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /**
   * Stops the helper. Closing stdin asks it to finalize any recording and
   * exit; it is only killed if it fails to do so in time. A later request
   * spawns a fresh process.
   */
  async dispose(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.rejectAll(new HelperExitedError('shut-down', 'disposed'))
    child.stdin.end()

    const killTimer = setTimeout(() => {
      this.logger.warn('helper did not exit in time; killing it')
      child.kill('SIGKILL')
    }, GRACEFUL_EXIT_TIMEOUT_MS)
    try {
      await this.exited
    } finally {
      clearTimeout(killTimer)
    }
  }

  private ensureStarted(): HelperChild {
    if (this.child) return this.child

    const child = this.spawnHelper()
    this.child = child
    this.spawnCount += 1

    const decoder = new JsonLineDecoder(
      (message) => this.handleMessage(message),
      (reason) => this.logger.warn('invalid helper output', { reason })
    )
    child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.logger.warn('helper stderr', { text })
    })
    // Writes to a helper that already died surface here; the exit handler reports it.
    child.stdin.on('error', () => undefined)

    this.exited = new Promise<void>((resolve) => {
      let settled = false
      const finish = (kind: HelperExitKind, reason: string): void => {
        if (settled) return
        settled = true
        resolve()
        this.handleExit(child, kind, reason)
      }
      child.on('exit', (code, signal) =>
        finish('crashed', `code ${code ?? 'null'}, signal ${signal ?? 'none'}`)
      )
      // Emitted instead of `exit` when the binary cannot be executed at all.
      child.on('error', (error) => finish('spawn-failed', error.message))
    })
    this.logger.info('helper started', { generation: this.spawnCount })
    return child
  }

  private handleExit(child: HelperChild, kind: HelperExitKind, reason: string): void {
    // `dispose` clears `this.child` first, so a match means nobody asked for this exit.
    const expected = this.child !== child
    if (!expected) {
      this.child = null
      this.logger.error('helper exited unexpectedly', { kind, reason })
      this.rejectAll(new HelperExitedError(kind, reason))
    } else {
      this.logger.info('helper exited', { reason })
    }
    for (const listener of this.exitListeners) listener(expected)
  }

  private handleMessage(raw: unknown): void {
    const message = parseHelperMessage(raw)
    if (!message) {
      this.logger.warn('unrecognized helper message')
      return
    }
    switch (message.type) {
      case 'response': {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id)
        clearTimeout(request.timer)
        if (message.ok) {
          request.resolve(message.result)
        } else {
          request.reject(
            new HelperRequestError(message.error ?? { code: 'unknown', message: 'no error payload' })
          )
        }
        return
      }
      case 'event':
        for (const listener of this.eventListeners) listener(message.name, message.payload)
        return
      case 'log':
        this.forwardLog(message)
        return
    }
  }

  private forwardLog(entry: HelperLog): void {
    let logger = this.helperLoggers.get(entry.scope)
    if (!logger) {
      logger = createLogger(entry.scope)
      this.helperLoggers.set(entry.scope, logger)
    }
    const level = entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info'
    logger[level](entry.message, entry.data)
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
