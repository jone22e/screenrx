import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAudioGraph } from '@engine/export/audioFilters'
import { buildTimeMap } from '@engine/time/timeMapping'
import { bundledFfmpegBinaries } from './FfmpegService'

/**
 * The audio mix through the real FFmpeg: a "voice" that speaks for two
 * seconds in the middle of six, and "music" the whole way. The mixed file
 * is then measured, so the ducking and the loudness are checked by what
 * comes out, not by the filter text.
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

/** RMS level in dB of `filePath` between two instants, after `filter`. */
async function rmsDb(filePath: string, fromSec: number, toSec: number, filter = 'anull'): Promise<number> {
  const output = await run(['-i', filePath, '-af', `atrim=${fromSec}:${toSec},${filter},astats=measure_overall=RMS_level:measure_perchannel=none`, '-f', 'null', '-'])
  const match = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(output)
  if (!match) throw new Error(`no RMS in ${output.slice(-400)}`)
  return match[1] === '-inf' ? -Infinity : Number(match[1])
}

/** Integrated loudness (LUFS) of `filePath`. */
async function integratedLufs(filePath: string): Promise<number> {
  const output = await run(['-i', filePath, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'])
  const match = /I:\s*(-?[\d.]+) LUFS/.exec(output)
  if (!match) throw new Error(`no loudness in ${output.slice(-400)}`)
  return Number(match[1])
}

describe('audio mix through FFmpeg', () => {
  let directory: string
  let voicePath: string
  let musicPath: string
  const DURATION_MS = 6000
  const map = buildTimeMap(DURATION_MS, [])

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-audio-mix-'))
    voicePath = path.join(directory, 'voice.m4a')
    musicPath = path.join(directory, 'music.m4a')
    // The voice: a 2 kHz tone from 2 s to 4 s, silence otherwise. `sine` plays at 1/8, so this is about −27 dB RMS: a quiet microphone.
    await run(['-f', 'lavfi', '-i', 'sine=frequency=2000:sample_rate=48000:duration=6', '-af', "volume='if(between(t,2,4),0.5,0)':eval=frame", '-c:a', 'aac', '-y', voicePath])
    // The music: a steady 110 Hz tone.
    await run(['-f', 'lavfi', '-i', 'sine=frequency=110:sample_rate=48000:duration=6', '-af', 'volume=0.5', '-c:a', 'aac', '-y', musicPath])
  }, 60_000)

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function mix(name: string, music: Parameters<typeof buildAudioGraph>[0]['music'], loudness: 'off' | 'social' = 'off'): Promise<string> {
    const graph = buildAudioGraph({ tracks: [{ inputIndex: 0, volume: 1 }], music, loudness }, map, 1)
    if (!graph) throw new Error('no graph')
    const outputPath = path.join(directory, `${name}.wav`)
    await run(['-i', voicePath, '-i', musicPath, '-filter_complex', graph.filter, '-map', graph.output, '-y', outputPath])
    return outputPath
  }

  it('presses the music down while the voice is heard, and brings it back after', async () => {
    const ducked = await mix('ducked', { inputIndex: 1, volume: 1, ducking: 'strong', fadeInMs: 0, fadeOutMs: 0 })
    // The music alone, below 300 Hz: the 2 kHz voice is filtered out of the measurement.
    const before = await rmsDb(ducked, 0.5, 1.8, 'lowpass=f=300')
    const during = await rmsDb(ducked, 2.5, 3.9, 'lowpass=f=300')
    const after = await rmsDb(ducked, 5.0, 5.9, 'lowpass=f=300')
    expect(before - during).toBeGreaterThan(6)
    expect(Math.abs(after - before)).toBeLessThan(1.5)

    const plain = await mix('plain', { inputIndex: 1, volume: 1, ducking: 'off', fadeInMs: 0, fadeOutMs: 0 })
    expect(Math.abs((await rmsDb(plain, 2.5, 3.9, 'lowpass=f=300')) - (await rmsDb(plain, 0.5, 1.8, 'lowpass=f=300')))).toBeLessThan(1)
  }, 60_000)

  it('fades the music in and out', async () => {
    const faded = await mix('faded', { inputIndex: 1, volume: 1, ducking: 'off', fadeInMs: 2000, fadeOutMs: 2000 })
    const start = await rmsDb(faded, 0, 0.3, 'lowpass=f=300')
    const middle = await rmsDb(faded, 4.2, 4.6, 'lowpass=f=300')
    const end = await rmsDb(faded, 5.7, 6, 'lowpass=f=300')
    expect(middle - start).toBeGreaterThan(10)
    expect(middle - end).toBeGreaterThan(10)
  }, 60_000)

  it('normalizes the finished mix to the social loudness', async () => {
    const quiet = await mix('quiet', { inputIndex: 1, volume: 0.05, ducking: 'off', fadeInMs: 0, fadeOutMs: 0 }, 'off')
    const normalized = await mix('normalized', { inputIndex: 1, volume: 0.05, ducking: 'off', fadeInMs: 0, fadeOutMs: 0 }, 'social')
    expect(await integratedLufs(quiet)).toBeLessThan(-20)
    expect(await integratedLufs(normalized)).toBeGreaterThan(-17)
    expect(await integratedLufs(normalized)).toBeLessThan(-11)
  }, 60_000)
})
