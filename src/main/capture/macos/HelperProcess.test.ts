import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../logging/logger'
import type { HelperChild } from './HelperProcess'
import {
  HelperExitedError,
  HelperProcess,
  HelperRequestError,
  HelperTimeoutError
} from './HelperProcess'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/** In-memory stand-in for the spawned helper. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly received: Array<{ id: string; method: string; params?: unknown }> = []
  killed = false

  constructor() {
    super()
    let buffer = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) this.received.push(JSON.parse(line))
    })
    // Like the real helper, exit once stdin is closed.
    this.stdin.on('end', () => this.emit('exit', 0, null))
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGKILL')
    return true
  }
}

let children: FakeChild[]
let helper: HelperProcess

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  children = []
  helper = new HelperProcess(() => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as HelperChild
  }, silentLogger)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HelperProcess', () => {
  it('spawns lazily and correlates responses with requests', async () => {
    expect(helper.isRunning).toBe(false)
    const first = helper.request<{ value: number }>('hello', undefined, 1000)
    const second = helper.request<{ value: number }>('permissions.status', { a: 1 }, 1000)
    await flush()

    const child = children[0]
    expect(children).toHaveLength(1)
    expect(child?.received.map((request) => request.method)).toEqual(['hello', 'permissions.status'])
    expect(child?.received[1]?.params).toEqual({ a: 1 })

    // Answer out of order.
    child?.send({ type: 'response', id: child.received[1]?.id, ok: true, result: { value: 2 } })
    child?.send({ type: 'response', id: child.received[0]?.id, ok: true, result: { value: 1 } })
    expect(await first).toEqual({ value: 1 })
    expect(await second).toEqual({ value: 2 })
  })

  it('rejects with the helper error payload', async () => {
    const request = helper.request('recording.start', {}, 1000)
    await flush()
    children[0]?.send({
      type: 'response',
      id: children[0].received[0]?.id,
      ok: false,
      error: { code: 'permission-denied', message: 'no access' }
    })
    await expect(request).rejects.toBeInstanceOf(HelperRequestError)
    await expect(request).rejects.toMatchObject({ payload: { code: 'permission-denied' } })
  })

  it('reassembles messages split across chunks', async () => {
    const request = helper.request<{ text: string }>('hello', undefined, 1000)
    await flush()
    const line = `${JSON.stringify({ type: 'response', id: '1', ok: true, result: { text: 'olá ✓' } })}\n`
    const bytes = Buffer.from(line, 'utf8')
    // Split inside the multi-byte check mark.
    children[0]?.stdout.write(bytes.subarray(0, bytes.length - 5))
    children[0]?.stdout.write(bytes.subarray(bytes.length - 5))
    expect(await request).toEqual({ text: 'olá ✓' })
  })

  it('delivers events to listeners', async () => {
    const events: Array<[string, unknown]> = []
    helper.onEvent((name, payload) => events.push([name, payload]))
    void helper.request('hello', undefined, 1000).catch(() => undefined)
    await flush()
    children[0]?.send({ type: 'event', name: 'recording.interrupted', payload: { x: 1 } })
    await flush()
    expect(events).toEqual([['recording.interrupted', { x: 1 }]])
  })

  it('rejects pending requests and reports an unexpected exit', async () => {
    const exits: boolean[] = []
    helper.onExit((expected) => exits.push(expected))
    const request = helper.request('recording.stop', undefined, 1000)
    await flush()
    children[0]?.emit('exit', null, 'SIGSEGV')

    await expect(request).rejects.toBeInstanceOf(HelperExitedError)
    await expect(request).rejects.toMatchObject({ kind: 'crashed' })
    expect(exits).toEqual([false])
    expect(helper.isRunning).toBe(false)
  })

  it('reports a helper that cannot be spawned', async () => {
    const request = helper.request('hello', undefined, 1000)
    await flush()
    children[0]?.emit('error', new Error('spawn screenrx-capture ENOENT'))
    await expect(request).rejects.toMatchObject({ kind: 'spawn-failed' })
  })

  it('respawns after an exit', async () => {
    void helper.request('hello', undefined, 1000).catch(() => undefined)
    await flush()
    children[0]?.emit('exit', 1, null)
    void helper.request('hello', undefined, 1000).catch(() => undefined)
    await flush()
    expect(children).toHaveLength(2)
    expect(helper.generation).toBe(2)
  })

  it('shuts down gracefully by closing stdin', async () => {
    const exits: boolean[] = []
    helper.onExit((expected) => exits.push(expected))
    const request = helper.request('hello', undefined, 1000)
    await flush()

    await helper.dispose()
    await expect(request).rejects.toMatchObject({ kind: 'shut-down' })
    expect(exits).toEqual([true])
    expect(children[0]?.killed).toBe(false)
  })

  it('times out requests the helper never answers', async () => {
    vi.useFakeTimers()
    const request = helper.request('sources.list', undefined, 500)
    const assertion = expect(request).rejects.toBeInstanceOf(HelperTimeoutError)
    await vi.advanceTimersByTimeAsync(500)
    await assertion
  })
})
