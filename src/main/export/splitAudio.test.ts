import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAudioGraph } from '@engine/export/audioFilters'
import { buildTimeMap } from '@engine/time/timeMapping'
import type { Layer } from '@shared/models/project'
import { DEFAULT_SPLIT } from '@shared/models/project'
import { bundledFfmpegBinaries } from './FfmpegService'
import { splitAudioOf } from './ExportService'

/**
 * A split screen's sound through the real FFmpeg: the recording hums at
 * 300 Hz for 6 s; a clip at 2 kHz is laid from 2 s to 4 s (taken from its
 * second 1). The mix is measured band by band, with a cut in the middle.
 */
const { ffmpeg } = bundledFfmpegBinaries()

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`ffmpeg ${code}: ${output.slice(-800)}`))))
  })
}

async function rmsDb(filePath: string, fromSec: number, toSec: number, filter: string): Promise<number> {
  const output = await run(['-i', filePath, '-af', `atrim=${fromSec}:${toSec},${filter},astats=measure_overall=RMS_level:measure_perchannel=none`, '-f', 'null', '-'])
  const match = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(output)
  if (!match) throw new Error(`no RMS in ${output.slice(-400)}`)
  return match[1] === '-inf' ? -Infinity : Number(match[1])
}

const MAIN = 'lowpass=f=600,lowpass=f=600,lowpass=f=600,lowpass=f=600'
const CLIP = 'highpass=f=1200,highpass=f=1200,highpass=f=1200,highpass=f=1200'

describe('split screen sound through FFmpeg', () => {
  let directory: string
  let mainPath: string
  let clipPath: string

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-split-audio-'))
    mainPath = path.join(directory, 'main.m4a')
    clipPath = path.join(directory, 'clip.m4a')
    await run(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=6', '-c:a', 'aac', '-y', mainPath])
    await run(['-f', 'lavfi', '-i', 'sine=frequency=2000:sample_rate=48000:duration=5', '-c:a', 'aac', '-y', clipPath])
  }, 60_000)

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function mix(name: string, alone: boolean, cuts: Array<{ startMs: number; endMs: number }> = []): Promise<string> {
    const map = buildTimeMap(6000, cuts.map((cut, index) => ({ id: `t${index}`, type: 'trim', startMs: cut.startMs, endMs: cut.endMs })) as never)
    const place = { atMs: 2000, offsetMs: 1000, lengthMs: 2000 }
    const graph = buildAudioGraph(
      {
        tracks: [
          { inputIndex: 0, volume: 1, ...(alone && { silences: [{ startMs: 2000, endMs: 4000 }] }) },
          { inputIndex: 1, volume: 1, place }
        ],
        music: null,
        loudness: 'off'
      },
      map,
      1
    )
    if (!graph) throw new Error('no graph')
    const outputPath = path.join(directory, `${name}.wav`)
    await run(['-i', mainPath, '-i', clipPath, '-filter_complex', graph.filter, '-map', graph.output, '-y', outputPath])
    return outputPath
  }

  it('plays the clip only during its span, with the recording when both are heard', async () => {
    const both = await mix('both', false)
    expect(await rmsDb(both, 0.3, 1.8, CLIP)).toBeLessThan(-60)
    expect(await rmsDb(both, 2.3, 3.7, CLIP)).toBeGreaterThan(-30)
    expect(await rmsDb(both, 4.3, 5.8, CLIP)).toBeLessThan(-60)
    expect(await rmsDb(both, 2.3, 3.7, MAIN)).toBeGreaterThan(-30)
  }, 60_000)

  it('silences the recording while the clip plays alone', async () => {
    const alone = await mix('alone', true)
    expect(await rmsDb(alone, 2.3, 3.7, MAIN)).toBeLessThan(-50)
    expect(await rmsDb(alone, 0.3, 1.7, MAIN)).toBeGreaterThan(-30)
    expect(await rmsDb(alone, 4.3, 5.8, MAIN)).toBeGreaterThan(-30)
    expect(await rmsDb(alone, 2.3, 3.7, CLIP)).toBeGreaterThan(-30)
  }, 60_000)

  it('keeps the clip where it was when a cut before it shortens the video', async () => {
    // One second cut out before the split: the clip now sounds from 1 s to 3 s of the output.
    const cut = await mix('cut', false, [{ startMs: 500, endMs: 1500 }])
    expect(await rmsDb(cut, 0.1, 0.9, CLIP)).toBeLessThan(-60)
    expect(await rmsDb(cut, 1.3, 2.7, CLIP)).toBeGreaterThan(-30)
    expect(await rmsDb(cut, 3.3, 4.8, CLIP)).toBeLessThan(-60)
  }, 60_000)
})

describe('splitAudioOf', () => {
  const layer = (extra: Partial<Layer> & object): Layer =>
    ({ id: 'v1', kind: 'video', file: 'clip.mp4', offsetMs: 500, startMs: 1000, endMs: 9000, position: { x: 0.5, y: 0.5 }, sizeRatio: 0.3, rotationDeg: 0, opacity: 1, cornerRadiusRatio: 0, ...extra }) as Layer

  it('takes only split layers whose clip has sound and may be heard, cut to the clip’s length', () => {
    const clips = [{ file: 'clip.mp4', hasAudio: true, durationMs: 4500 }]
    expect(splitAudioOf([layer({})], clips)).toEqual([])
    expect(splitAudioOf([layer({ split: { ...DEFAULT_SPLIT, audio: 'main' } } as never)], clips)).toEqual([])
    expect(splitAudioOf([layer({ split: { ...DEFAULT_SPLIT, audio: 'clip', clipVolume: 0.7 } } as never)], clips)).toEqual([
      { file: 'clip.mp4', atMs: 1000, offsetMs: 500, lengthMs: 4000, volume: 0.7, alone: true }
    ])
    expect(splitAudioOf([layer({ split: DEFAULT_SPLIT } as never)], [{ ...clips[0], hasAudio: false } as never])).toEqual([])
  })
})
