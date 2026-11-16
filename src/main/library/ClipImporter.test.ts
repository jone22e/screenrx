import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { ClipImportError, ClipImporter } from './ClipImporter'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('ClipImporter', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let directory: string
  let sessions: SessionStore
  let importer: ClipImporter
  let sessionId: string

  const run = (args: string[]): string => {
    const result = spawnSync(binaries.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const streamsOf = (file: string): string[] =>
    spawnSync(binaries.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim().split('\n')

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-clips-'))
    sessions = new SessionStore(path.join(directory, 'sessions'), silentLogger)
    importer = new ClipImporter({ ffmpeg, sessions, logger: silentLogger })
    const created = await sessions.create(
      { source: { kind: 'display', label: 'Display 1', displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo: false },
      new Date(2026, 10, 16, 10, 0, 0, 0)
    )
    sessionId = created.manifest.id
    await sessions.write({ ...created.manifest, status: 'completed' })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('brings a clip in as silent H.264 in the assets folder and lists it in the manifest', async () => {
    const source = path.join(directory, 'broll.mov')
    run(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source])
    const clip = await importer.import(sessionId, source)
    expect(clip.name).toBe('broll.mov')
    expect(clip.file).toMatch(/\.mp4$/)
    expect([clip.widthPx, clip.heightPx]).toEqual([320, 240])
    expect(clip.durationMs).toBeGreaterThan(1900)
    const target = path.join(sessions.directoryOf(sessionId), 'assets', clip.file)
    expect(streamsOf(target)).toHaveLength(1)
    expect(streamsOf(target)[0]).toContain('h264')
    expect((await sessions.read(sessionId))?.assets.videos).toEqual([clip])
  })

  it('refuses a file without video, and removes a clip', async () => {
    const audioOnly = path.join(directory, 'song.m4a')
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly])
    await expect(importer.import(sessionId, audioOnly)).rejects.toBeInstanceOf(ClipImportError)
    const source = path.join(directory, 'b.mp4')
    run(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source])
    const clip = await importer.import(sessionId, source)
    await importer.remove(sessionId, clip.file)
    expect((await sessions.read(sessionId))?.assets.videos).toEqual([])
    await expect(access(path.join(sessions.directoryOf(sessionId), 'assets', clip.file))).rejects.toThrow()
  })
})
