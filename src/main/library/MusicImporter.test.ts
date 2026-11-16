import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { MusicImportError, MusicImporter } from './MusicImporter'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('MusicImporter', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let directory: string
  let sessions: SessionStore
  let importer: MusicImporter
  let sessionId: string

  const run = (binary: string, args: string[]): string => {
    const result = spawnSync(binary, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  /** A three-second tone in the codec asked for. */
  const makeAudio = (name: string, codecArgs: string[]): string => {
    const file = path.join(directory, name)
    run(binaries.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', ...codecArgs, file])
    return file
  }
  const codecOf = (file: string): string =>
    run(binaries.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).trim()

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-music-'))
    sessions = new SessionStore(path.join(directory, 'sessions'), silentLogger)
    importer = new MusicImporter({ ffmpeg, sessions, logger: silentLogger })
    const created = await sessions.create(
      { source: { kind: 'display', label: 'Display 1', displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo: true },
      new Date(2026, 10, 16, 10, 0, 0, 0)
    )
    sessionId = created.manifest.id
    await sessions.write({ ...created.manifest, status: 'completed' })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('brings an MP3 in as the session music track, re-encoded to AAC, and records it in the manifest', async () => {
    const track = await importer.import(sessionId, makeAudio('song.mp3', ['-c:a', 'libmp3lame']))
    expect(track.name).toBe('song.mp3')
    expect(track.durationMs).toBeGreaterThan(2900)
    expect(track.url).toBe(`screenrx-media://session/${sessionId}/music`)
    const file = sessions.trackPathOf(sessionId, 'music')
    expect(codecOf(file)).toBe('aac')
    const manifest = await sessions.read(sessionId)
    expect(manifest?.assets.music?.name).toBe('song.mp3')
    expect(manifest?.assets.music?.file).toBe('music.m4a')
    expect(manifest?.assets.music?.sizeBytes).toBeGreaterThan(0)
  })

  it('replaces the music whole when another file is chosen, and removes it', async () => {
    await importer.import(sessionId, makeAudio('first.m4a', ['-c:a', 'aac']))
    const second = await importer.import(sessionId, makeAudio('second.wav', ['-c:a', 'pcm_s16le']))
    expect(second.name).toBe('second.wav')
    expect((await sessions.read(sessionId))?.assets.music?.name).toBe('second.wav')

    await importer.remove(sessionId)
    expect((await sessions.read(sessionId))?.assets.music).toBeUndefined()
    await expect(access(sessions.trackPathOf(sessionId, 'music'))).rejects.toThrow()
  })

  it('refuses a file without audio and leaves no track behind', async () => {
    const silent = path.join(directory, 'picture.mp4')
    run(binaries.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-an', silent])
    await expect(importer.import(sessionId, silent)).rejects.toBeInstanceOf(MusicImportError)
    await expect(importer.import(sessionId, silent)).rejects.toMatchObject({ appError: { code: 'music-unsupported' } })
    await expect(access(sessions.trackPathOf(sessionId, 'music'))).rejects.toThrow()
    expect((await sessions.read(sessionId))?.assets.music).toBeUndefined()
  })
})
