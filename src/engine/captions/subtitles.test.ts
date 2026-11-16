import { describe, expect, it } from 'vitest'
import type { CaptionCue, TrimEffect } from '@shared/models/project'
import { createCaptionSettings, spreadWords } from '@shared/models/project'
import { buildTimeMap } from '../time/timeMapping'
import { formatSubtitles, parseSubtitles, subtitleCues } from './subtitles'

const cue = (id: string, startMs: number, endMs: number, text: string): CaptionCue => ({
  id,
  startMs,
  endMs,
  text,
  words: spreadWords(text, startMs, endMs)
})

describe('subtitleCues', () => {
  const captions = {
    ...createCaptionSettings(),
    cues: [cue('a', 0, 1000, 'Olá, pessoal.'), cue('b', 2000, 3000, 'Isto sai.'), cue('c', 4000, 6000, 'Vamos exportar.')],
    translations: { en: { a: 'Hi everyone.' } }
  }

  it('puts the captions on the clock of the finished video', () => {
    const cut: TrimEffect = { id: 't', type: 'trim', startMs: 1500, endMs: 3500 }
    const map = buildTimeMap(10_000, [cut])
    expect(subtitleCues(captions, map, 1)).toEqual([
      { startMs: 0, endMs: 1000, text: 'Olá, pessoal.' },
      { startMs: 2000, endMs: 4000, text: 'Vamos exportar.' }
    ])
  })

  it('applies the export speed and the chosen language', () => {
    const map = buildTimeMap(10_000, [])
    expect(subtitleCues({ ...captions, language: 'en' }, map, 2)).toEqual([
      { startMs: 0, endMs: 500, text: 'Hi everyone.' },
      { startMs: 1000, endMs: 1500, text: 'Isto sai.' },
      { startMs: 2000, endMs: 3000, text: 'Vamos exportar.' }
    ])
  })
})

describe('formatSubtitles', () => {
  const cues = [
    { startMs: 0, endMs: 1250, text: 'Olá' },
    { startMs: 3_661_007, endMs: 3_662_000, text: 'Tchau' }
  ]

  it('writes SRT with a comma in the timestamps', () => {
    expect(formatSubtitles(cues, 'srt')).toBe('1\n00:00:00,000 --> 00:00:01,250\nOlá\n\n2\n01:01:01,007 --> 01:01:02,000\nTchau\n')
  })

  it('writes WebVTT with its header and a dot in the timestamps', () => {
    expect(formatSubtitles(cues, 'vtt')).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.250\nOlá\n\n2\n01:01:01.007 --> 01:01:02.000\nTchau\n'
    )
  })
})

describe('parseSubtitles', () => {
  it('reads SRT, joining the lines of a subtitle', () => {
    const file = '1\r\n00:00:00,500 --> 00:00:02,000\r\nOlá,\r\npessoal.\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n<i>Tchau</i>\r\n'
    expect(parseSubtitles(file)).toEqual([
      { startMs: 500, endMs: 2000, text: 'Olá, pessoal.' },
      { startMs: 2000, endMs: 3000, text: 'Tchau' }
    ])
  })

  it('reads WebVTT, with or without hours and cue names', () => {
    const file = 'WEBVTT\n\nintro\n00:01.000 --> 00:02.500 line:90%\nOi\n\n01:00:00.000 --> 01:00:01.000\nFim\n'
    expect(parseSubtitles(file)).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Oi' },
      { startMs: 3_600_000, endMs: 3_601_000, text: 'Fim' }
    ])
  })

  it('sorts and removes overlaps, and skips what it cannot read', () => {
    const file = '1\n00:00:02,000 --> 00:00:04,000\nsegundo\n\nlixo\n\n2\n00:00:01,000 --> 00:00:03,000\nprimeiro\n\n3\n00:00:05,000 --> 00:00:05,010\ncurto\n'
    expect(parseSubtitles(file)).toEqual([
      { startMs: 1000, endMs: 3000, text: 'primeiro' },
      { startMs: 3000, endMs: 4000, text: 'segundo' }
    ])
    expect(parseSubtitles('nada aqui')).toEqual([])
  })
})
