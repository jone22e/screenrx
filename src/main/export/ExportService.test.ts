import { describe, expect, it } from 'vitest'
import { createExportPlan } from '@engine/export/exportPlan'
import { buildTimeMap } from '@engine/time/timeMapping'
import { encodeArguments, suggestedFileName } from './ExportService'

const map = buildTimeMap(60_000, [])
const plan = (speed: number, fps: 24 | 30 | 60 = 30) =>
  createExportPlan({ width: 3600, height: 2338 }, map, { format: 'mp4', quality: 'standard', fps, speed })

const valueAfter = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

describe('encodeArguments', () => {
  it('reads raw frames from stdin and writes yuv420p H.264 in an MP4', () => {
    const args = encodeArguments(plan(1), 'h264_videotoolbox', [], map, '/tmp/out.mp4.part')
    expect(args.join(' ')).toContain('-f rawvideo -pix_fmt rgba -video_size 1920x1246 -framerate 30 -i pipe:0')
    expect(valueAfter(args, '-c:v')).toBe('h264_videotoolbox')
    expect(valueAfter(args, '-vf')).toContain('format=yuv420p')
    expect(valueAfter(args, '-t')).toBe('60.000')
    expect(valueAfter(encodeArguments(plan(1, 60), 'h264_videotoolbox', [], map, '/tmp/o'), '-framerate')).toBe('60')
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/tmp/out.mp4.part'])
    // No audio tracks, so no audio processing at all.
    expect(args).not.toContain('-filter_complex')
    expect(args).not.toContain('-c:a')
  })

  it('falls back to software encoding', () => {
    const args = encodeArguments(plan(1), 'libx264', [], map, '/tmp/out.mp4.part')
    expect(valueAfter(args, '-c:v')).toBe('libx264')
    expect(args).toContain('-crf')
  })

  it('processes and mixes the audio tracks in the same run, at the export speed', () => {
    const args = encodeArguments(plan(2), 'h264_videotoolbox', ['/s/microphone.m4a', '/s/system.m4a'], map, '/tmp/o.part')
    expect(args.filter((arg) => arg === '-i')).toHaveLength(3)
    expect(valueAfter(args, '-filter_complex')).toContain('atempo=2')
    expect(args).toContain('[aout]')
    expect(valueAfter(args, '-c:a')).toBe('aac')
    // 60 s at 2x.
    expect(valueAfter(args, '-t')).toBe('30.000')
  })
})

describe('suggestedFileName', () => {
  it('names the file after the recording, its date and the speed', () => {
    const createdAt = new Date(2026, 9, 3, 21, 29).toISOString()
    expect(suggestedFileName('Display 1', createdAt, 1)).toBe('Display 1 2026-10-03 21.29.mp4')
    expect(suggestedFileName('Display 1', createdAt, 1.5)).toBe('Display 1 2026-10-03 21.29 1,5x.mp4')
  })

  it('never produces path separators or other unsafe characters', () => {
    const name = suggestedFileName('Chrome — a/b\\c:d*e?"<>|\u0000', 'not a date', 2)
    expect(name).toBe('Chrome — a-b-c-d-e----- 2x.mp4')
    expect(name).not.toMatch(/[/\\]/)
  })
})
