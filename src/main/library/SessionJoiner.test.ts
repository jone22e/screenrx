import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_FILES } from '@shared/config/recording'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { JoinError, SessionJoiner } from './SessionJoiner'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('SessionJoiner', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let directory: string
  let sessions: SessionStore
  let joiner: SessionJoiner

  const run = (args: string[]): void => {
    const result = spawnSync(binaries.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }

  /** A finished recording of `seconds` at `size`, with a microphone track when asked and pointer telemetry. */
  const makeRecording = async (label: string, size: string, seconds: number, microphone: boolean, cursorInVideo = false): Promise<string> => {
    const created = await sessions.create(
      { source: { kind: 'display', label, displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo },
      new Date(2026, 10, 16, 10, 0, 0, 0)
    )
    run(['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', created.screenPath])
    if (microphone) run(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', created.microphonePath])
    await writeFile(created.cursorPath, JSON.stringify([{ timeMs: 0, x: 0.5, y: 0.5 }, { timeMs: 500, x: 1, y: 1 }]))
    await writeFile(created.interactionsPath, JSON.stringify([{ timeMs: 250, type: 'click', x: 0.5, y: 0.5, button: 'left' }]))
    const [width, height] = size.split('x').map(Number) as [number, number]
    await sessions.write({
      ...created.manifest,
      status: 'completed',
      clock: { durationMs: seconds * 1000, pauses: [] },
      assets: {
        screen: { file: SESSION_FILES.screen, sizeBytes: 1, durationMs: seconds * 1000, widthPx: width, heightPx: height, frameCount: seconds * 30, droppedFrameCount: 0 },
        ...(microphone && { microphone: { file: SESSION_FILES.microphone, sizeBytes: 1, durationMs: seconds * 1000 } }),
        cursor: { file: SESSION_FILES.cursor, entryCount: 2 },
        interactions: { file: SESSION_FILES.interactions, entryCount: 1 }
      }
    })
    return created.manifest.id
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-join-'))
    sessions = new SessionStore(path.join(directory, 'sessions'), silentLogger)
    joiner = new SessionJoiner({ ffmpeg, sessions, logger: silentLogger, now: () => new Date(2026, 10, 16, 11, 0, 0, 0) })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('joins two recordings end to end, fitting the second into the first frame, with silence where a track is missing', async () => {
    const first = await makeRecording('Tela 1', '320x180', 2, true)
    const second = await makeRecording('Tela 2', '180x180', 1, false)
    const joinedId = await joiner.join([first, second])
    const manifest = await sessions.read(joinedId)
    expect(manifest?.status).toBe('completed')
    expect(manifest?.title).toBeUndefined()
    expect(manifest?.source).toMatchObject({ kind: 'file', label: 'Tela 1 + Tela 2' })
    expect(manifest?.assets.screen).toMatchObject({ widthPx: 320, heightPx: 180 })
    expect(manifest?.assets.screen?.durationMs).toBeGreaterThan(2900)
    expect(manifest?.assets.screen?.durationMs).toBeLessThan(3200)
    expect(manifest?.assets.microphone?.durationMs).toBeGreaterThan(2900)
    expect(manifest?.capture.cursorInVideo).toBe(false)

    // The second part's pointer, in its square frame, lands in the middle third of the wide joined frame, 2 s later.
    const cursor = JSON.parse(await readFile(path.join(sessions.directoryOf(joinedId), SESSION_FILES.cursor), 'utf8')) as Array<{ timeMs: number; x: number; y: number }>
    expect(cursor).toHaveLength(4)
    expect(cursor[2]).toMatchObject({ timeMs: 2000, y: 0.5 })
    expect(cursor[2]?.x).toBeCloseTo((320 - 180) / 2 / 320 + 0.5 * (180 / 320))
    expect(cursor[3]).toMatchObject({ timeMs: 2500, y: 1 })
    const interactions = JSON.parse(await readFile(path.join(sessions.directoryOf(joinedId), SESSION_FILES.interactions), 'utf8')) as Array<{ timeMs: number }>
    expect(interactions.map((event) => event.timeMs)).toEqual([250, 2250])
    // The parts are untouched.
    expect((await sessions.read(first))?.status).toBe('completed')
  })

  it('keeps the system cursor flag when any part has the cursor in the picture, and refuses a single recording', async () => {
    const first = await makeRecording('A', '160x90', 1, false, true)
    const second = await makeRecording('B', '160x90', 1, false)
    const joinedId = await joiner.join([second, first])
    expect((await sessions.read(joinedId))?.capture.cursorInVideo).toBe(true)
    await expect(joiner.join([first])).rejects.toBeInstanceOf(JoinError)
  })
})
