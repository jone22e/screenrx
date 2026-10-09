import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { ImportError, VideoImporter, canCopyVideo, importBitrate } from './VideoImporter'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('canCopyVideo', () => {
  it('copies 8-bit 4:2:0 H.264 and re-encodes everything else', () => {
    const video = { codec: 'h264', pixelFormat: 'yuv420p', widthPx: 1920, heightPx: 1080, fps: 30, rotationDeg: 0 }
    expect(canCopyVideo(video)).toBe(true)
    // A phone video asks to be shown rotated: it is re-encoded upright, so the file needs no rotating.
    expect(canCopyVideo({ ...video, rotationDeg: 90 })).toBe(false)
    expect(canCopyVideo({ ...video, rotationDeg: 270 })).toBe(false)
    expect(canCopyVideo({ ...video, pixelFormat: 'yuvj420p' })).toBe(true)
    expect(canCopyVideo({ ...video, pixelFormat: 'yuv420p10le' })).toBe(false)
    expect(canCopyVideo({ ...video, pixelFormat: null })).toBe(false)
    expect(canCopyVideo({ ...video, codec: 'hevc' })).toBe(false)
  })
})

describe('importBitrate', () => {
  it('follows the export rule within its bounds', () => {
    expect(importBitrate(1920, 1080, 30)).toBe(Math.round(1920 * 1080 * 30 * 0.14))
    expect(importBitrate(320, 240, 10)).toBe(4_000_000)
    expect(importBitrate(7680, 4320, 60)).toBe(40_000_000)
  })
})

describe('VideoImporter', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let directory: string
  let root: string
  let sessions: SessionStore
  let importer: VideoImporter

  const run = (binary: string, args: string[]): string => {
    const result = spawnSync(binary, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  /** A two-second test pattern with a tone, in the codecs asked for. */
  const makeVideo = (name: string, videoArgs: string[], withAudio: boolean, size = '320x240'): string => {
    const file = path.join(directory, name)
    run(binaries.ffmpeg, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=2`,
      ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'] : []),
      ...videoArgs,
      ...(withAudio ? ['-c:a', 'aac'] : []),
      file
    ])
    return file
  }
  const streamsOf = (file: string): string[] =>
    run(binaries.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file])
      .trim()
      .split('\n')

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-import-src-'))
    root = await mkdtemp(path.join(tmpdir(), 'screenrx-import-lib-'))
    sessions = new SessionStore(root, silentLogger)
    importer = new VideoImporter({ ffmpeg, sessions, logger: silentLogger, now: () => new Date(2026, 9, 8, 10, 0, 0, 0) })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it('brings an H.264 file with audio in as a completed session with screen and microphone tracks', async () => {
    const file = makeVideo('Minha demo.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], true)

    const sessionId = await importer.import(file)

    expect(sessionId).toBe('recording-20261008-100000-000')
    const manifest = await sessions.read(sessionId)
    expect(manifest?.status).toBe('completed')
    expect(manifest?.source).toEqual({ kind: 'file', label: 'Minha demo', displayId: null, windowId: null, appName: null })
    expect(manifest?.capture.fps).toBe(25)
    expect(manifest?.assets.screen).toMatchObject({ file: 'screen.mp4', widthPx: 320, heightPx: 240, frameCount: 50 })
    expect(manifest?.assets.screen?.durationMs).toBeGreaterThan(1900)
    expect(manifest?.clock.durationMs).toBe(manifest?.assets.screen?.durationMs)
    expect(manifest?.assets.microphone).toMatchObject({ file: 'microphone.m4a' })
    expect(manifest?.assets.microphone?.durationMs).toBeGreaterThan(1900)
    expect(manifest?.diagnostics).toEqual([expect.objectContaining({ level: 'info', code: 'telemetry-missing' })])

    // The screen track holds video only; the audio went to its own track.
    expect(streamsOf(sessions.trackPathOf(sessionId, 'screen'))).toEqual(['h264,video'])
    expect(streamsOf(sessions.trackPathOf(sessionId, 'microphone'))).toEqual(['aac,audio'])
    const summary = (await sessions.list())[0]
    expect(summary).toMatchObject({ id: sessionId, title: 'Minha demo', hasMicrophone: true, hasSystemAudio: false })
  })

  it('re-encodes video that is not H.264 and skips the audio track when there is none', async () => {
    const file = makeVideo('clip.avi', ['-c:v', 'mpeg4'], false)

    const sessionId = await importer.import(file)

    const manifest = await sessions.read(sessionId)
    expect(manifest?.assets.microphone).toBeUndefined()
    expect(streamsOf(sessions.trackPathOf(sessionId, 'screen'))).toEqual(['h264,video'])
    expect(await readdir(path.join(root, sessionId))).toEqual(['screen.mp4', 'session.json'])
  })

  it('re-encodes odd-sized video to even dimensions and records the size actually written', async () => {
    const file = makeVideo('odd.avi', ['-c:v', 'mpeg4'], false, '321x241')

    const sessionId = await importer.import(file)

    expect((await sessions.read(sessionId))?.assets.screen).toMatchObject({ widthPx: 320, heightPx: 240 })
  })

  it('bakes in the rotation a phone video asks for, so the stored frames are upright', async () => {
    // A display matrix, as phones write it: set on the way in and kept by the stream copy.
    const plain = makeVideo('plain.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], false)
    const file = path.join(directory, 'phone.mp4')
    run(binaries.ffmpeg, ['-v', 'error', '-y', '-display_rotation', '90', '-i', plain, '-c:v', 'copy', file])
    expect((await ffmpeg.probeMedia(file)).video?.rotationDeg).not.toBe(0)

    const sessionId = await importer.import(file)

    const screen = sessions.trackPathOf(sessionId, 'screen')
    expect((await sessions.read(sessionId))?.assets.screen).toMatchObject({ widthPx: 240, heightPx: 320 })
    expect((await ffmpeg.probeMedia(screen)).video).toMatchObject({ widthPx: 240, heightPx: 320, rotationDeg: 0 })
  })

  it('rejects a file without video and leaves nothing behind', async () => {
    const file = path.join(directory, 'tone.m4a')
    run(binaries.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', file])

    await expect(importer.import(file)).rejects.toMatchObject({ appError: { code: 'import-unsupported' } })
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a file that is not media and leaves nothing behind', async () => {
    const error = await importer.import(path.join(directory, 'missing.mp4')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ImportError)
    expect((error as ImportError).appError.code).toBe('import-unsupported')
    expect(await readdir(root)).toEqual([])
  })
})
