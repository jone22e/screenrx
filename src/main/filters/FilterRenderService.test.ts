import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import type { Logger } from '../logging/logger'
import { SessionStore } from '../recording/SessionStore'
import { FilterRenderError, FilterRenderService } from './FilterRenderService'

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
const off = { enabled: false as const, strength: 'medium' as const }

describe('FilterRenderService', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let root: string
  let sessions: SessionStore
  let sessionId: string
  const progress: number[] = []
  const service = () => new FilterRenderService({ ffmpeg, sessions, logger: silentLogger, onProgress: (p) => progress.push(p.fraction) })

  const probe = (file: string): string =>
    spawnSync(binaries.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim()

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'screenrx-fx-'))
    sessions = new SessionStore(root, silentLogger)
    progress.length = 0
    // A two-second session whose screen track is a moving test pattern.
    const created = await sessions.create(
      { source: { kind: 'file', label: 'fx', displayId: null, windowId: null, appName: null }, fps: 25, cursorInVideo: true },
      new Date(2026, 9, 9, 10, 0, 0, 0)
    )
    sessionId = created.manifest.id
    const made = spawnSync(binaries.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', created.screenPath])
    if (made.status !== 0) throw new Error(made.stderr.toString())
    await sessions.write({
      ...created.manifest,
      status: 'completed',
      clock: { durationMs: 2000, pauses: [] },
      assets: { screen: { file: 'screen.mp4', sizeBytes: 1, durationMs: 2000, widthPx: 320, heightPx: 240, frameCount: 50, droppedFrameCount: 0 } }
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('renders the effects track in two passes when stabilizing, and describes what it was made from', async () => {
    const track = await service().render(sessionId, { stabilization: { enabled: true, strength: 'light' }, denoise: off, sharpen: { enabled: true, strength: 'medium' } })

    expect(track).toEqual({ url: `screenrx-media://session/${sessionId}/screenFx`, key: 'stabilization=light;denoise=off;sharpen=medium' })
    expect(probe(sessions.trackPathOf(sessionId, 'screenFx'))).toBe('h264,320,240,50')
    const info = JSON.parse(await readFile(path.join(root, sessionId, 'screen-fx.json'), 'utf8')) as { key: string }
    expect(info.key).toBe(track.key)
    // The detection pass's transforms are not left behind.
    expect((await readdir(path.join(root, sessionId))).sort()).toEqual(['screen-fx.json', 'screen-fx.mp4', 'screen.mp4', 'session.json'])
    expect(progress.length).toBeGreaterThan(0)
    expect(Math.max(...progress)).toBeLessThanOrEqual(1)
    // The recording itself is untouched.
    expect(probe(sessions.trackPathOf(sessionId, 'screen'))).toBe('h264,320,240,50')
  })

  it('renders in one pass without stabilization, and reads the track back', async () => {
    const renderer = service()
    await renderer.render(sessionId, { stabilization: off, denoise: { enabled: true, strength: 'strong' }, sharpen: off })
    expect(await renderer.trackOf(sessionId)).toEqual({ url: `screenrx-media://session/${sessionId}/screenFx`, key: 'stabilization=off;denoise=strong;sharpen=off' })
  })

  it('can be cancelled, leaving no partial file', async () => {
    const renderer = service()
    const rendering = renderer.render(sessionId, { stabilization: { enabled: true, strength: 'medium' }, denoise: off, sharpen: off })
    await new Promise((resolve) => setTimeout(resolve, 50))
    renderer.cancel()
    await expect(rendering).rejects.toMatchObject({ appError: { code: 'filters-cancelled' } })
    expect((await readdir(path.join(root, sessionId))).some((name) => name.endsWith('.part') || name.endsWith('.trf'))).toBe(false)
    expect(await renderer.trackOf(sessionId)).toBeNull()
  })

  it('refuses a session without a screen track', async () => {
    await expect(service().render('recording-20260101-000000-000', { stabilization: off, denoise: off, sharpen: off })).rejects.toBeInstanceOf(FilterRenderError)
  })
})
