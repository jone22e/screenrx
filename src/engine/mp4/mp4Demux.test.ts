import { spawnSync } from 'node:child_process'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundledFfmpegBinaries } from '../../main/export/FfmpegService'
import type { ByteSource } from './mp4Demux'
import { Mp4Error, describeMp4, hevcCodecString } from './mp4Demux'

const binaries = bundledFfmpegBinaries()

const run = (args: string[]): void => {
  const result = spawnSync(binaries.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

/** A file on disk, read by ranges as the browser reads a `File`. */
async function fileSource(filePath: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(filePath, 'r')
  const { size } = await stat(filePath)
  return {
    size,
    async read(offset, length) {
      const buffer = new Uint8Array(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    },
    close: () => handle.close()
  }
}

describe('describeMp4', () => {
  let directory: string
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-mp4-'))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('reads the H.264 samples, keyframes and audio of a file with reordered frames', async () => {
    const file = path.join(directory, 'bframes.mp4')
    run([
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', '-g', '15', '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', file
    ])
    const source = await fileSource(file)
    try {
      const description = await describeMp4(source)
      expect(Math.round(description.durationMs)).toBeGreaterThanOrEqual(1990)
      expect(description.unsupportedVideo).toBeNull()
      const video = description.video
      expect(video).not.toBeNull()
      if (!video) return
      expect(video.codec).toMatch(/^avc1\.[0-9a-f]{6}$/)
      expect(video.description[0]).toBe(1)
      expect(video.widthPx).toBe(320)
      expect(video.heightPx).toBe(240)
      expect(video.sizes).toHaveLength(60)
      expect(video.keyframes[0]).toBe(true)
      expect(video.keyframes.filter(Boolean).length).toBe(4)
      // Decode order differs from display order, but every frame is shown once, 1/30 s apart.
      const shown = [...video.timestampsUs].sort((a, b) => a - b)
      expect(shown[0]).toBe(0)
      expect(shown[59]).toBe(Math.round((59 / 30) * 1_000_000))
      for (const [index, size] of video.sizes.entries()) {
        const offset = video.offsets[index] ?? 0
        expect(offset + size).toBeLessThanOrEqual(source.size)
        // Each sample starts with a 4-byte NAL length that fits inside it.
        const head = await source.read(offset, 4)
        const nalLength = ((head[0] ?? 0) << 24) | ((head[1] ?? 0) << 16) | ((head[2] ?? 0) << 8) | (head[3] ?? 0)
        expect(nalLength).toBeLessThanOrEqual(size - 4)
      }
      expect(description.audio).toEqual({ codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 })
    } finally {
      await source.close()
    }
  })

  it('finds the moov at the end of the file too, and reports a video without audio', async () => {
    const file = path.join(directory, 'tail.mov')
    run(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file])
    const source = await fileSource(file)
    try {
      const description = await describeMp4(source)
      expect(description.video?.sizes).toHaveLength(10)
      expect(description.video?.keyframes.every(Boolean)).toBe(false)
      expect(description.audio).toBeNull()
    } finally {
      await source.close()
    }
  })

  it('rejects what is not an MP4', async () => {
    const bytes = new TextEncoder().encode('not a video at all, just some text that is long enough')
    const source: ByteSource = { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }
    await expect(describeMp4(source)).rejects.toBeInstanceOf(Mp4Error)
  })
})

describe('hevcCodecString', () => {
  it('spells Main profile at level 4 as the platforms do', () => {
    // version 1; profile space 0, tier L, profile 1; compatibility 0x60000000; constraints 0x90 00…; level 120.
    const hvcC = Uint8Array.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120])
    expect(hevcCodecString('hvc1', hvcC)).toBe('hvc1.1.6.L120.90')
  })
})
