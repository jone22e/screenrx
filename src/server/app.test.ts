import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeWav16 } from '@engine/audio/wav'
import type { Logger } from '../main/logging/logger'
import { createApp } from './app'
import type { ServerConfig, TranscriptionConfig } from './config'
import { configFromEnv } from './config'
import { resolveStaticPath } from './static'

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

const RATE = 16_000

interface Upstream {
  calls: Array<{ language: string | null; seconds: number; authorization: string | null; model: string | null }>
  answer: (call: Upstream['calls'][number]) => Response | Promise<Response>
  /** `POST /models/{id}` requests, by model id. */
  installs: string[]
  installAnswer: () => Response
}

/** Stands in for the transcription service: records what it was asked and answers as told. */
function fakeUpstream(): { upstream: Upstream; fetchImpl: typeof fetch } {
  const upstream: Upstream = {
    calls: [],
    answer: () => new Response(JSON.stringify({ language: 'portuguese', words: [], segments: [] }), { status: 200 }),
    installs: [],
    installAnswer: () => new Response('not found', { status: 404 })
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('http://whisper.test/v1/models/')) {
      expect(init?.method).toBe('POST')
      upstream.installs.push(decodeURIComponent(url.slice('http://whisper.test/v1/models/'.length)))
      return upstream.installAnswer()
    }
    expect(url).toBe('http://whisper.test/v1/audio/transcriptions')
    const body = init?.body as FormData
    const file = body.get('file') as Blob
    const headers = new Headers(init?.headers)
    const call = {
      language: (body.get('language') as string | null) ?? null,
      seconds: (file.size - 44) / 2 / RATE,
      authorization: headers.get('authorization'),
      model: body.get('model') as string | null
    }
    upstream.calls.push(call)
    return upstream.answer(call)
  }
  return { upstream, fetchImpl }
}

async function listen(config: ServerConfig, fetchImpl?: typeof fetch): Promise<{ server: Server; origin: string }> {
  const server = createServer(createApp({ config, logger: silentLogger, fetchImpl }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()))

/** The JSON lines of a transcription answer, in order. */
async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const transcription: TranscriptionConfig = {
  baseUrl: 'http://whisper.test/v1',
  apiKey: 'secret',
  model: 'whisper-1',
  maxMinutes: 2,
  chunkMinutes: 1,
  concurrency: 2,
  timeoutSeconds: 30
}

describe('configFromEnv', () => {
  it('turns transcription off without a service address and bounds the numbers', () => {
    const config = configFromEnv({ PORT: '99999' }, '/srv')
    expect(config.port).toBe(65535)
    expect(config.webDir).toBe('/srv/out/web')
    expect(config.transcription).toBeNull()
  })

  it('reads the transcription service and its defaults', () => {
    const config = configFromEnv({ SCREENRX_TRANSCRIPTION_URL: 'https://api.openai.com/v1/', SCREENRX_TRANSCRIPTION_KEY: 'k' }, '/srv')
    expect(config.transcription).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'whisper-1',
      maxMinutes: 120,
      chunkMinutes: 1,
      concurrency: 2,
      timeoutSeconds: 300
    })
  })
})

describe('resolveStaticPath', () => {
  it('keeps requests inside the web directory', () => {
    expect(resolveStaticPath('/srv/web', '/index.html')).toBe(path.resolve('/srv/web/index.html'))
    expect(resolveStaticPath('/srv/web', '/assets/a.js')).toBe(path.resolve('/srv/web/assets/a.js'))
    // Climbing out is folded back to the root.
    expect(resolveStaticPath('/srv/web', '/%2e%2e/package.json')).toBe(path.resolve('/srv/web/package.json'))
    expect(resolveStaticPath('/srv/web', '/a/%2e%2e/%2e%2e/%2e%2e/etc/passwd')).toBe(path.resolve('/srv/web/etc/passwd'))
    expect(resolveStaticPath('/srv/web', '/a%00.js')).toBeNull()
    expect(resolveStaticPath('/srv/web', '/%E0%A4%A')).toBeNull()
  })
})

describe('web server', () => {
  let webDir: string
  beforeAll(async () => {
    webDir = await mkdtemp(path.join(os.tmpdir(), 'screenrx-web-'))
    await mkdir(path.join(webDir, 'assets'))
    await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>ScreenRx</title>')
    await writeFile(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  })
  afterAll(async () => {
    await rm(webDir, { recursive: true, force: true })
  })

  it('serves the page, its assets and the page again for addresses inside the app', async () => {
    const { server, origin } = await listen({ host: '127.0.0.1', port: 0, webDir, transcription: null })
    try {
      const home = await fetch(`${origin}/`)
      expect(home.status).toBe(200)
      expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(home.headers.get('cache-control')).toBe('no-cache')
      expect(await home.text()).toContain('ScreenRx')

      const asset = await fetch(`${origin}/assets/app-abc123.js`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')

      expect((await fetch(`${origin}/editor/web-abc`)).status).toBe(200)
      expect((await fetch(`${origin}/missing.png`)).status).toBe(404)
      expect((await fetch(`${origin}/%2e%2e/package.json`)).status).toBe(404)
      expect((await fetch(`${origin}/api/nothing`)).status).toBe(404)
      expect((await fetch(`${origin}/healthz`)).status).toBe(200)

      const info = await (await fetch(`${origin}/api/transcription`)).json()
      expect(info).toEqual({ transcription: false, maxMinutes: 0 })
      expect((await fetch(`${origin}/api/transcription`, { method: 'POST', body: new Uint8Array(100) })).status).toBe(404)
    } finally {
      await close(server)
    }
  })

  it('transcribes in pieces, offsetting the words and reporting progress', async () => {
    const { upstream, fetchImpl } = fakeUpstream()
    upstream.answer = (call) =>
      new Response(
        JSON.stringify({
          language: 'portuguese',
          words: [{ word: 'oi', start: 1, end: 1.5 }],
          segments: [{ start: 0, end: call.seconds, text: 'Oi.' }]
        })
      )
    const { server, origin } = await listen({ host: '127.0.0.1', port: 0, webDir, transcription }, fetchImpl)
    try {
      const info = await (await fetch(`${origin}/api/transcription`)).json()
      expect(info).toEqual({ transcription: true, maxMinutes: 2 })

      // 100 s of noise with a quiet stretch at 55 s, where the cut lands.
      const samples = new Int16Array(RATE * 100)
      for (let index = 0; index < samples.length; index++) samples[index] = ((index * 7919) % 2000) - 1000
      samples.fill(0, RATE * 55, RATE * 56)
      const response = await fetch(`${origin}/api/transcription?locale=pt-BR`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: encodeWav16(samples, RATE)
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
      const lines = await events(response)
      expect(lines.map((line) => line.type)).toEqual(['progress', 'progress', 'progress', 'done'])
      // The pieces run together: the first done is shown with the other's estimate; the last is whole.
      const fractions = lines.slice(0, 3).map((line) => line.fraction as number)
      expect(fractions[0]).toBe(0)
      expect(fractions[1]).toBeGreaterThan(0.5)
      expect(fractions[1]).toBeLessThan(1)
      expect(fractions[2]).toBe(1)
      const done = lines[3] as { words: Array<{ text: string; startMs: number; endMs: number }>; language: string }
      expect(done.language).toBe('portuguese')
      expect(done.words).toHaveLength(2)
      expect(done.words[0]).toEqual({ text: 'Oi.', startMs: 1000, endMs: 1500 })
      expect(done.words[1]?.startMs).toBeGreaterThanOrEqual(56_000)
      expect(done.words[1]?.startMs).toBeLessThanOrEqual(57_000)

      expect(upstream.calls).toHaveLength(2)
      expect(upstream.calls[0]).toMatchObject({ language: 'pt', authorization: 'Bearer secret', model: 'whisper-1' })
      expect(upstream.calls[0]!.seconds + upstream.calls[1]!.seconds).toBeCloseTo(100, 3)
    } finally {
      await close(server)
    }
  })

  it('has a self-hosted service fetch the model when it is missing, and at start', async () => {
    const { upstream, fetchImpl } = fakeUpstream()
    let installed = false
    upstream.installAnswer = () => {
      installed = true
      return new Response('{}', { status: 201 })
    }
    upstream.answer = () =>
      installed
        ? new Response(JSON.stringify({ language: 'pt', words: [{ word: 'oi', start: 0, end: 0.2 }], segments: [] }))
        : new Response(JSON.stringify({ detail: "Model 'whisper-1' is not installed locally. You can download the model using `POST /v1/models`" }), { status: 404 })
    const { server, origin } = await listen({ host: '127.0.0.1', port: 0, webDir, transcription }, fetchImpl)
    try {
      // The warm-up at start asked for the model once already.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(upstream.installs).toEqual(['whisper-1'])
      installed = false
      const response = await fetch(`${origin}/api/transcription?locale=pt-BR`, { method: 'POST', body: encodeWav16(new Int16Array(RATE * 5), RATE) })
      const lines = await events(response)
      expect(lines.map((line) => line.type)).toEqual(['progress', 'progress', 'progress', 'done'])
      expect(lines[1]).toEqual({ type: 'progress', fraction: 0, stage: 'downloading' })
      expect(lines.at(-1)).toMatchObject({ type: 'done', words: [{ text: 'oi', startMs: 0, endMs: 200 }] })
      expect(upstream.installs).toEqual(['whisper-1', 'whisper-1'])
      expect(upstream.calls).toHaveLength(2)
    } finally {
      await close(server)
    }
  })

  it('tells the language from the first seconds', async () => {
    const { upstream, fetchImpl } = fakeUpstream()
    upstream.answer = () => new Response(JSON.stringify({ language: 'en', words: [{ word: 'hi', start: 0, end: 0.2 }], segments: [] }))
    const { server, origin } = await listen({ host: '127.0.0.1', port: 0, webDir, transcription }, fetchImpl)
    try {
      const response = await fetch(`${origin}/api/transcription?mode=detect`, { method: 'POST', body: encodeWav16(new Int16Array(RATE * 60), RATE) })
      const lines = await events(response)
      expect(lines.at(-1)).toEqual({ type: 'done', words: [{ text: 'hi', startMs: 0, endMs: 200 }], language: 'en' })
      expect(upstream.calls).toHaveLength(1)
      expect(upstream.calls[0]?.language).toBeNull()
      expect(upstream.calls[0]?.seconds).toBe(20)
    } finally {
      await close(server)
    }
  })

  it('refuses what it cannot take and reports the service failing', async () => {
    const { upstream, fetchImpl } = fakeUpstream()
    const { server, origin } = await listen({ host: '127.0.0.1', port: 0, webDir, transcription }, fetchImpl)
    try {
      expect((await fetch(`${origin}/api/transcription`, { method: 'POST', body: encodeWav16(new Int16Array(RATE), RATE) })).status).toBe(400)
      expect((await fetch(`${origin}/api/transcription?locale=pt-BR`, { method: 'POST', body: new Uint8Array(500) })).status).toBe(400)
      const stereo = await fetch(`${origin}/api/transcription?locale=pt-BR`, { method: 'POST', body: encodeWav16(new Int16Array(RATE * 2), RATE, 2) })
      expect(stereo.status).toBe(400)

      const tooLong = await fetch(`${origin}/api/transcription?locale=pt-BR`, { method: 'POST', body: encodeWav16(new Int16Array(RATE * 150), RATE) })
      expect((await events(tooLong)).at(-1)).toEqual({ type: 'error', code: 'transcription-too-long' })

      const huge = await fetch(`${origin}/api/transcription?locale=pt-BR`, {
        method: 'POST',
        headers: { 'Content-Length': String(2 * 60 * 48_000 * 2 + 2 * 1024 * 1024) },
        body: new Uint8Array(10),
        // The server answers before the body is read; the client would otherwise insist on sending it.
        duplex: 'half'
      } as RequestInit).catch(() => null)
      if (huge) expect(huge.status).toBe(413)

      upstream.answer = () => new Response('rate limited', { status: 429 })
      const failed = await fetch(`${origin}/api/transcription?locale=pt-BR`, { method: 'POST', body: encodeWav16(new Int16Array(RATE * 5), RATE) })
      const lines = await events(failed)
      expect(lines.at(-1)).toMatchObject({ type: 'error', code: 'transcription-failed', detail: '429 rate limited' })

      upstream.answer = () => {
        throw new TypeError('fetch failed')
      }
      const down = await fetch(`${origin}/api/transcription?locale=pt-BR`, { method: 'POST', body: encodeWav16(new Int16Array(RATE * 5), RATE) })
      expect((await events(down)).at(-1)).toMatchObject({ type: 'error', code: 'transcription-server-unreachable' })
    } finally {
      await close(server)
    }
  })
})

describe('PieceProgress', () => {
  it('estimates the pieces in flight and learns the speed from the ones done', async () => {
    const { PieceProgress } = await import('./transcription/transcriptionRoute')
    let now = 0
    const progress = new PieceProgress([60, 60], () => now)
    expect(progress.fraction()).toBe(0)
    progress.start(0)
    progress.start(1)
    now = 10_000
    // Assumed real time: 10 s of each 60 s piece after 10 s.
    expect(progress.fraction()).toBeCloseTo(20 / 120, 5)
    now = 60_000
    // Never past 92% of a piece still out.
    expect(progress.fraction()).toBeCloseTo(0.92, 5)
    progress.finish(0)
    // The first piece took 60 s for 60 s: speed 1×. The second is capped anyway.
    expect(progress.fraction()).toBeCloseTo((60 + 55.2) / 120, 5)
    now = 30_000
    // Time going backwards (tests) never lowers what was shown.
    expect(progress.fraction()).toBeCloseTo((60 + 55.2) / 120, 5)
    progress.finish(1)
    expect(progress.fraction()).toBe(1)
  })
})
