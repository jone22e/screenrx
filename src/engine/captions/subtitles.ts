import type { SubtitleFormat } from '@shared/models/captions'
import type { CaptionSettings } from '@shared/models/project'
import type { TimeMap } from '../time/timeMapping'
import { sourceTimeToTimelineTime, timelineTimeToOutputTime } from '../time/timeMapping'
import { cueText } from './captionCues'

/** One subtitle of a file: a text over a span of the FINISHED video's time. */
export interface SubtitleCue {
  startMs: number
  endMs: number
  text: string
}

/** Shortest subtitle kept when a file is read or written. */
const MIN_SUBTITLE_MS = 50

/**
 * The captions as subtitles of the exported video: on the output clock, so
 * they line up with the file after the cuts and the speed. A caption cut out
 * entirely is left out; one cut partly keeps what survives.
 */
export function subtitleCues(captions: CaptionSettings, map: TimeMap, exportSpeed: number): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const cue of captions.cues) {
    const startMs = timelineTimeToOutputTime(sourceTimeToTimelineTime(map, cue.startMs), exportSpeed)
    const endMs = timelineTimeToOutputTime(sourceTimeToTimelineTime(map, cue.endMs), exportSpeed)
    if (endMs - startMs < MIN_SUBTITLE_MS) continue
    const text = cueText(captions, cue).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    cues.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text })
  }
  return cues
}

const pad = (value: number, length: number): string => String(value).padStart(length, '0')

/** `hh:mm:ss` and the milliseconds, joined by `separator` (`,` in SRT, `.` in VTT). */
function timestamp(ms: number, separator: string): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(total % 1000, 3)}`
}

export function formatSubtitles(cues: readonly SubtitleCue[], format: SubtitleFormat): string {
  const separator = format === 'srt' ? ',' : '.'
  const blocks = cues.map(
    (cue, index) => `${index + 1}\n${timestamp(cue.startMs, separator)} --> ${timestamp(cue.endMs, separator)}\n${cue.text}`
  )
  const body = blocks.join('\n\n')
  return format === 'srt' ? `${body}\n` : `WEBVTT\n\n${body}\n`
}

const TIME_LINE = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/

function parseTime(hours: string | undefined, minutes: string, seconds: string, fraction: string): number {
  const ms = Number(fraction.padEnd(3, '0'))
  return (Number(hours ?? '0') * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + ms
}

/**
 * Reads an SRT or WebVTT file into subtitles, sorted and never overlapping.
 * Blocks that do not carry a time line, and anything inside tags, are
 * skipped; what cannot be read is simply left out.
 */
export function parseSubtitles(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIndex = lines.findIndex((line) => TIME_LINE.test(line))
    if (timeIndex === -1) continue
    const match = TIME_LINE.exec(lines[timeIndex] as string)
    if (!match) continue
    const startMs = parseTime(match[1], match[2] as string, match[3] as string, match[4] as string)
    const endMs = parseTime(match[5], match[6] as string, match[7] as string, match[8] as string)
    const text = lines
      .slice(timeIndex + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '' || endMs - startMs < MIN_SUBTITLE_MS) continue
    cues.push({ startMs, endMs, text })
  }
  cues.sort((a, b) => a.startMs - b.startMs)
  // One that starts before the previous one ends gives way to it.
  const clean: SubtitleCue[] = []
  for (const cue of cues) {
    const previous = clean[clean.length - 1]
    const startMs = previous ? Math.max(cue.startMs, previous.endMs) : cue.startMs
    if (cue.endMs - startMs < MIN_SUBTITLE_MS) continue
    clean.push({ ...cue, startMs })
  }
  return clean
}
