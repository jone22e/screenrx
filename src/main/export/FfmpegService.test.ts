import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FfmpegService, bundledFfmpegBinaries, parseMediaProbe, parseVideoPackets } from './FfmpegService'

describe('parseVideoPackets', () => {
  it('reads timestamps, positions and keyframes', () => {
    const packets = parseVideoPackets('0.000000,48211,48,K_\n0.016667,1203,48259,__\n1.000000,50112,49462,K_\n')
    expect(packets).toEqual([
      { timestampUs: 0, offset: 48, size: 48211, keyframe: true },
      { timestampUs: 16667, offset: 48259, size: 1203, keyframe: false },
      { timestampUs: 1_000_000, offset: 49462, size: 50112, keyframe: true }
    ])
  })

  it('skips blank and malformed lines', () => {
    expect(parseVideoPackets('\n\nN/A,10,20,K_\n0.5,0,20,__\n0.5,10,20,__\n')).toEqual([
      { timestampUs: 500_000, offset: 20, size: 10, keyframe: false }
    ])
  })
})

describe('FfmpegService audio clips', () => {
  const binaries = bundledFfmpegBinaries()
  const service = new FfmpegService(binaries, { debug() {}, info() {}, warn() {}, error() {} })
  let directory: string

  /** Runs the bundled FFmpeg directly, to make inputs and to measure outputs. */
  const ffmpeg = (args: string[]): string => {
    const result = spawnSync(binaries.ffmpeg, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stderr
  }
  const tone = (name: string, seconds: number): string => {
    const file = path.join(directory, name)
    ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '24000', '-ac', '1', file])
    return file
  }
  /** Mean volume, in dB, of `[fromS, toS)` of a file. */
  const volume = (file: string, fromS: number, toS: number): number => {
    const report = ffmpeg(['-v', 'info', '-ss', String(fromS), '-to', String(toS), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
    return Number(/mean_volume: (-?[\d.]+|-inf)/.exec(report)?.[1]?.replace('-inf', '-200'))
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-ffmpeg-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('cuts a stretch of an audio file', async () => {
    const source = tone('source.wav', 3)
    const clip = path.join(directory, 'clip.wav')
    await service.extractAudioClip(source, clip, 500, 2000, 24_000)
    expect(await service.durationOf(clip)).toBeCloseTo(1500, -2)
  })

  it('lays clips on a track at their times, silent in between, as long as asked', async () => {
    const clip = tone('clip.wav', 0.5)
    const track = path.join(directory, 'track.m4a')
    await service.mixClips(
      [
        { path: clip, startMs: 0 },
        { path: clip, startMs: 2000 }
      ],
      4000,
      track
    )
    expect(await service.durationOf(track)).toBeCloseTo(4000, -2)
    expect(volume(track, 0.1, 0.4)).toBeGreaterThan(-30)
    expect(volume(track, 1.0, 1.8)).toBeLessThan(-60)
    expect(volume(track, 2.1, 2.4)).toBeGreaterThan(-30)
    expect(volume(track, 3.0, 3.9)).toBeLessThan(-60)
  })

  it('mixes more clips than FFmpeg opens at once, in groups', async () => {
    const clip = tone('clip.wav', 0.05)
    const clips = Array.from({ length: 60 }, (_, index) => ({ path: clip, startMs: index * 100 }))
    const track = path.join(directory, 'many.m4a')
    await service.mixClips(clips, 7000, track)
    expect(await service.durationOf(track)).toBeCloseTo(7000, -2)
    // The last clip, from the second group, is there; no intermediate file is left.
    expect(volume(track, 5.9, 5.96)).toBeGreaterThan(-40)
    expect((await readdir(directory)).sort()).toEqual(['clip.wav', 'many.m4a'])
  })

  it('writes a silent track when there is nothing to place', async () => {
    const track = path.join(directory, 'empty.m4a')
    await service.mixClips([], 2000, track)
    expect(await service.durationOf(track)).toBeCloseTo(2000, -2)
    expect(volume(track, 0, 2)).toBeLessThan(-60)
  })
})

describe('parseMediaProbe', () => {
  it('reads the first video and audio streams and the length', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
        { codec_type: 'video', codec_name: 'mjpeg', width: 100, height: 100, avg_frame_rate: '0/0' }
      ],
      format: { duration: '12.345' }
    })
    expect(parseMediaProbe(json)).toEqual({
      durationMs: 12_345,
      video: { codec: 'h264', pixelFormat: 'yuv420p', widthPx: 1920, heightPx: 1080, fps: 29.97 },
      audio: { codec: 'aac' }
    })
  })

  it('reports a file without video, an unknown frame rate and a missing duration', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'vp9', width: 640, height: 360, avg_frame_rate: '0/0' }],
      format: {}
    })
    expect(parseMediaProbe(json)).toEqual({
      durationMs: 0,
      video: { codec: 'vp9', pixelFormat: null, widthPx: 640, heightPx: 360, fps: 0 },
      audio: null
    })
    expect(parseMediaProbe(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: {} }))).toEqual({
      durationMs: 0,
      video: null,
      audio: { codec: 'mp3' }
    })
  })

  it('is null for output that describes no media', () => {
    expect(parseMediaProbe('')).toBeNull()
    expect(parseMediaProbe('{}')).toBeNull()
    expect(parseMediaProbe(JSON.stringify({ streams: [], format: { duration: '1' } }))).toBeNull()
  })
})
