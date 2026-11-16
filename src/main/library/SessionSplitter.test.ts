import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_FILES } from '@shared/config/recording'
import type { SeriesProgress } from '@shared/models/series'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { SessionSplitter, SplitError } from './SessionSplitter'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('SessionSplitter', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let directory: string
  let sessions: SessionStore
  let progress: SeriesProgress[]
  let splitter: SessionSplitter

  const run = (args: string[]): void => {
    const result = spawnSync(binaries.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }

  /** A finished 4 s recording with a microphone track, pointer telemetry and a transcript of one word a second. */
  const makeRecording = async (): Promise<string> => {
    const created = await sessions.create(
      { source: { kind: 'display', label: 'Tela', displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo: false },
      new Date(2026, 10, 16, 10, 0, 0, 0)
    )
    run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', created.screenPath])
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', created.microphonePath])
    run(['-f', 'lavfi', '-i', 'testsrc=size=96x54:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '90', created.webcamPath])
    await writeFile(created.cursorPath, JSON.stringify([{ timeMs: 500, x: 0.1, y: 0.1 }, { timeMs: 2500, x: 0.9, y: 0.9 }, { timeMs: 3500, x: 0.5, y: 0.5 }]))
    await writeFile(created.interactionsPath, JSON.stringify([{ timeMs: 2600, type: 'click', x: 0.5, y: 0.5, button: 'left' }]))
    await writeFile(
      path.join(created.directory, SESSION_FILES.transcript),
      JSON.stringify({ schemaVersion: 1, locale: 'pt-BR', track: 'microphone', words: [0, 1, 2, 3].map((second) => ({ text: `w${second}`, startMs: second * 1000, endMs: second * 1000 + 800 })) })
    )
    await sessions.write({
      ...created.manifest,
      title: 'Aula inteira',
      status: 'completed',
      clock: { durationMs: 4000, pauses: [] },
      assets: {
        screen: { file: SESSION_FILES.screen, sizeBytes: 1, durationMs: 4000, widthPx: 160, heightPx: 90, frameCount: 120, droppedFrameCount: 0 },
        microphone: { file: SESSION_FILES.microphone, sizeBytes: 1, durationMs: 4000, deviceName: 'Mic' },
        webcam: { file: SESSION_FILES.webcam, sizeBytes: 1, durationMs: 4000, widthPx: 96, heightPx: 54, deviceName: 'Cam' },
        cursor: { file: SESSION_FILES.cursor, entryCount: 3 },
        interactions: { file: SESSION_FILES.interactions, entryCount: 1 }
      }
    })
    return created.manifest.id
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-split-'))
    sessions = new SessionStore(path.join(directory, 'sessions'), silentLogger)
    progress = []
    splitter = new SessionSplitter({ ffmpeg, sessions, logger: silentLogger, onProgress: (entry) => progress.push(entry), now: () => new Date(2026, 10, 16, 11, 0, 0, 0) })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('cuts each episode out as a recording of its own, in the series, with telemetry and transcript shifted to zero', async () => {
    const source = await makeRecording()
    // The second episode is planned at 2.4 s; the keyframe before it is at 2.0 s, where it actually starts.
    const ids = await splitter.split(source, { seriesTitle: 'Curso', episodes: [{ startMs: 0, endMs: 2400, title: 'Começo' }, { startMs: 2400, endMs: 4000, title: 'Fim' }] })
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    const [first, second] = await Promise.all(ids.map((id) => sessions.read(id)))
    expect(first).toMatchObject({ status: 'completed', title: '1. Começo', series: 'Curso', source: { kind: 'display', label: '1. Começo' } })
    expect(second).toMatchObject({ status: 'completed', title: '2. Fim', series: 'Curso' })
    expect(first?.assets.screen?.durationMs).toBeGreaterThan(1800)
    expect(first?.assets.screen?.durationMs).toBeLessThan(2200)
    expect(second?.assets.microphone?.durationMs).toBeGreaterThan(1800)
    expect(second?.assets.microphone?.deviceName).toBe('Mic')
    // The webcam's keyframes are 3 s apart; its stretch is re-encoded, so the episode still starts at 2 s.
    expect(second?.assets.webcam).toMatchObject({ widthPx: 96, heightPx: 54, deviceName: 'Cam' })
    expect(second?.assets.webcam?.durationMs).toBeGreaterThan(1800)
    expect(second?.assets.webcam?.durationMs).toBeLessThan(2200)

    // The second episode keeps only what happened in its stretch, 2 s earlier.
    const cursor = JSON.parse(await readFile(path.join(sessions.directoryOf(ids[1] as string), SESSION_FILES.cursor), 'utf8')) as Array<{ timeMs: number }>
    expect(cursor.map((sample) => sample.timeMs)).toEqual([500, 1500])
    const clicks = JSON.parse(await readFile(path.join(sessions.directoryOf(ids[1] as string), SESSION_FILES.interactions), 'utf8')) as Array<{ timeMs: number }>
    expect(clicks.map((event) => event.timeMs)).toEqual([600])
    const transcript = JSON.parse(await readFile(path.join(sessions.directoryOf(ids[1] as string), SESSION_FILES.transcript), 'utf8')) as { words: Array<{ text: string; startMs: number }> }
    expect(transcript.words.map((word) => [word.text, word.startMs])).toEqual([['w2', 0], ['w3', 1000]])

    expect(progress.map((entry) => [entry.done, entry.title])).toEqual([[0, 'Começo'], [1, 'Fim'], [2, '']])
    expect(await sessions.listSeries()).toEqual(['Curso'])
    // The source is untouched, and the library lists all three.
    expect((await sessions.read(source))?.title).toBe('Aula inteira')
    expect(await sessions.list()).toHaveLength(3)
  })

  it('refuses a recording that is not finished', async () => {
    const created = await sessions.create({ source: { kind: 'display', label: 'x', displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo: false }, new Date())
    await expect(splitter.split(created.manifest.id, { seriesTitle: 'S', episodes: [{ startMs: 0, endMs: 6000, title: 'a' }] })).rejects.toBeInstanceOf(SplitError)
  })
})
