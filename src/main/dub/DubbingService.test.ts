import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DubProgress, DubRequest } from '@shared/models/dub'
import type { FfmpegService } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { DubError, DubbingService } from './DubbingService'

const SESSION_ID = 'recording-20260101-000000-000'
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

let directory: string
let models: string
let calls: { clips: Array<{ path: string; startMs: number }>; durationMs: number; reference: number[] }

/**
 * A stand-in for the voice helper, in Node: `prepare` marks the model ready;
 * `synthesize` "speaks" every job by writing its text to the output file and
 * reporting a duration of 100 ms per character.
 */
async function fakeHelper(extra = ''): Promise<string> {
  const file = path.join(directory, 'helper.mjs')
  await writeFile(
    file,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
const say = (message) => console.log(JSON.stringify(message))
appendFileSync(join(${JSON.stringify(directory)}, 'helper.log'), args.join(' ') + '\\n')
${extra}
if (args[0] === 'prepare') {
  say({ type: 'status', state: 'downloading' })
  say({ type: 'progress', fraction: 0.5 })
  const dir = join(value('--models'), 'mlx-audio', 'mlx-community_OmniVoice-4bit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.screenrx-unpacked'), '')
  console.log('Using cached model at: somewhere')
  say({ type: 'done' })
} else {
  say({ type: 'status', state: 'synthesizing' })
  const jobs = JSON.parse(readFileSync(value('--jobs'), 'utf8'))
  jobs.forEach((job, index) => {
    writeFileSync(job.output, job.text)
    say({ type: 'item', id: job.id, durationMs: job.text.length * 100 })
    say({ type: 'progress', fraction: (index + 1) / jobs.length })
  })
  say({ type: 'done' })
}
`
  )
  await chmod(file, 0o755)
  return file
}

function createService(helperPath: string | null) {
  const progress: DubProgress[] = []
  calls = { clips: [], durationMs: 0, reference: [] }
  const sessions = {
    read: () => Promise.resolve({ assets: { screen: { durationMs: 10_000 }, microphone: { durationMs: 10_000 } } }),
    trackPathOf: (_id: string, track: string) => path.join(directory, `${track}.out`)
  } as unknown as SessionStore
  const ffmpeg = {
    extractAudioClip: (_input: string, output: string, startMs: number, endMs: number) => {
      calls.reference = [startMs, endMs]
      return writeFile(output, 'voice')
    },
    mixClips: async (clips: Array<{ path: string; startMs: number }>, durationMs: number, output: string) => {
      calls.clips = clips
      calls.durationMs = durationMs
      // What was "spoken", in the order it was placed.
      const texts = await Promise.all(clips.map((clip) => readFile(clip.path, 'utf8')))
      await writeFile(output, texts.join('|'))
    }
  } as unknown as FfmpegService
  const service = new DubbingService({
    helperPath,
    transcriberPath: null,
    modelsDirectory: models,
    ffmpeg,
    sessions,
    logger,
    onProgress: (entry) => progress.push(entry)
  })
  return { service, progress }
}

const request: DubRequest = {
  language: 'zh',
  units: [
    { id: 'unit-1', startMs: 0, slotEndMs: 3000, text: '大家好。' },
    { id: 'unit-2', startMs: 3000, slotEndMs: 10_000, text: '今天我们来导出视频。' }
  ],
  reference: { startMs: 0, endMs: 4000, text: 'Olá pessoal, hoje vamos exportar.' }
}

const errorCodeOf = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation
  } catch (error) {
    if (error instanceof DubError) return error.appError.code
    throw error
  }
  return 'no error'
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'screenrx-dub-test-'))
  models = path.join(directory, 'models')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('DubbingService', () => {
  it('reports the model as missing until it is prepared, then ready', async () => {
    const { service, progress } = createService(await fakeHelper())
    expect(await service.status()).toMatchObject({ available: true, model: 'missing' })
    expect((await service.status()).modelDownloadBytes).toBeGreaterThan(1_000_000_000)

    expect(await service.prepareModel()).toMatchObject({ model: 'ready' })
    expect(progress).toContainEqual({ stage: 'downloading', fraction: 0.5 })

    expect(await service.removeModel()).toMatchObject({ model: 'missing' })
  })

  it('is unavailable without a voice helper', async () => {
    const { service } = createService(null)
    expect(await service.status()).toMatchObject({ available: false })
    expect(await errorCodeOf(service.prepareModel())).toBe('dub-unavailable')
    expect(await errorCodeOf(service.generate(SESSION_ID, request))).toBe('dub-unavailable')
  })

  it('refuses to dub before the model is there', async () => {
    const { service } = createService(await fakeHelper())
    expect(await errorCodeOf(service.generate(SESSION_ID, request))).toBe('dub-model-missing')
  })

  it('speaks every stretch in the cloned voice and lays them on a track of the session', async () => {
    const { service, progress } = createService(await fakeHelper())
    await service.prepareModel()

    const track = await service.generate(SESSION_ID, request)

    expect(track).toEqual({ language: 'zh', url: `screenrx-media://session/${SESSION_ID}/dubZh` })
    // The voice is learned from the stretch of the microphone that was asked for.
    expect(calls.reference).toEqual([0, 4000])
    // Each stretch starts with its caption; the track is as long as the recording.
    expect(calls.clips.map((clip) => clip.startMs)).toEqual([0, 3000])
    expect(calls.durationMs).toBe(10_000)
    expect(await readFile(path.join(directory, 'dubZh.out'), 'utf8')).toBe('大家好。|今天我们来导出视频。')
    // Written under another name and renamed: no partial file is left.
    await expect(stat(path.join(directory, 'dubZh.out.part'))).rejects.toThrow()

    const invocation = (await readFile(path.join(directory, 'helper.log'), 'utf8')).split('\n')[1] ?? ''
    expect(invocation).toContain('--language zh')
    expect(invocation).toContain(`--models ${models}`)
    expect(progress.map((entry) => entry.stage)).toEqual(expect.arrayContaining(['synthesizing', 'assembling']))
  })

  it('makes a stretch that ran over wait, instead of talking over the next one', async () => {
    const { service } = createService(await fakeHelper())
    await service.prepareModel()
    // 40 characters "last" 4 s, a second more than the first slot.
    const long = { ...request, units: [{ ...request.units[0]!, text: 'x'.repeat(40) }, request.units[1]!] }
    await service.generate(SESSION_ID, long)
    expect(calls.clips[1]?.startMs).toBeGreaterThan(4000)
  })

  it('fails with the reason the helper gives', async () => {
    const helper = await fakeHelper(
      `if (args[0] === 'synthesize') { say({ type: 'error', code: 'failed', detail: 'out of memory' }); process.exit(1) }`
    )
    const { service } = createService(helper)
    await service.prepareModel()
    try {
      await service.generate(SESSION_ID, request)
      expect.unreachable()
    } catch (error) {
      expect((error as DubError).appError).toMatchObject({ code: 'dub-failed', detail: 'failed: out of memory' })
    }
    // Nothing of a failed dubbing is left in the session.
    await expect(stat(path.join(directory, 'dubZh.out'))).rejects.toThrow()
  })

  it('can be cancelled, and does one thing at a time', async () => {
    const helper = await fakeHelper(`if (args[0] === 'synthesize') { await new Promise((resolve) => setTimeout(resolve, 30000)) }`)
    const { service } = createService(helper)
    await service.prepareModel()

    const first = errorCodeOf(service.generate(SESSION_ID, request))
    await vi.waitFor(async () => {
      const log = await readFile(path.join(directory, 'helper.log'), 'utf8')
      expect(log).toContain('synthesize')
    })
    expect(await errorCodeOf(service.generate(SESSION_ID, request))).toBe('dub-busy')
    service.cancel()
    expect(await first).toBe('dub-cancelled')
  })

  it('needs a microphone track to learn the voice from', async () => {
    const { service } = createService(await fakeHelper())
    await service.prepareModel()
    await mkdir(models, { recursive: true })
    const withoutMicrophone = new DubbingService({
      helperPath: path.join(directory, 'helper.mjs'),
      transcriberPath: null,
      modelsDirectory: models,
      ffmpeg: {} as FfmpegService,
      sessions: { read: () => Promise.resolve({ assets: { screen: { durationMs: 1000 } } }) } as unknown as SessionStore,
      logger,
      onProgress: () => undefined
    })
    expect(await errorCodeOf(withoutMicrophone.generate(SESSION_ID, request))).toBe('dub-failed')
  })
})
