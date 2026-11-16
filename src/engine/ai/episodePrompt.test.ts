import { describe, expect, it } from 'vitest'
import type { TranscriptWord } from '@shared/models/captions'
import { buildEpisodePrompt, parseEpisodeResponse } from './episodePrompt'

// 100 words, one every second, with a 3 s silence after word 49.
const words: TranscriptWord[] = Array.from({ length: 100 }, (_, index) => {
  const startMs = index * 1000 + (index >= 50 ? 3000 : 0)
  return { text: `w${index}`, startMs, endMs: startMs + 800 }
})
const durationMs = 110_000

describe('buildEpisodePrompt', () => {
  it('numbers the words, marks the long pauses, and says how long the episodes should be', () => {
    const { prompt, system, wordCount } = buildEpisodePrompt(words, 'pt-BR', 180)
    expect(wordCount).toBe(100)
    expect(prompt).toContain('0 w0')
    expect(prompt).toContain('99 w99')
    expect(prompt).toContain('-- pause 3.2s --')
    expect(prompt).toContain('about 3 minutes (180 seconds)')
    expect(system).toContain('word indices')
  })
})

describe('parseEpisodeResponse', () => {
  it('turns word spans into episodes that cover the whole recording, numbered when untitled', () => {
    const plan = parseEpisodeResponse(
      { seriesTitle: 'Loja do zero', episodes: [{ fromWord: 2, toWord: 49, title: 'Cadastro' }, { fromWord: 50, toWord: 90, title: '' }] },
      words,
      durationMs,
      'Gravação'
    )
    expect(plan?.seriesTitle).toBe('Loja do zero')
    // The first starts at 0, the second where the first ended, and the last runs to the end.
    expect(plan?.episodes).toEqual([
      { startMs: 0, endMs: 49_800, title: 'Cadastro' },
      { startMs: 49_800, endMs: durationMs, title: 'Episódio 2' }
    ])
  })

  it('merges an episode too short to stand alone into the one before, and sorts what comes out of order', () => {
    const plan = parseEpisodeResponse(
      { seriesTitle: '', episodes: [{ fromWord: 60, toWord: 99, title: 'B' }, { fromWord: 0, toWord: 57, title: 'A' }, { fromWord: 58, toWord: 59, title: 'tiny' }] },
      words,
      durationMs,
      'Gravação'
    )
    expect(plan?.seriesTitle).toBe('Gravação')
    expect(plan?.episodes.map((episode) => episode.title)).toEqual(['A', 'B'])
    expect(plan?.episodes[0]?.endMs).toBe(62_800)
  })

  it('gives nothing for an answer without usable episodes', () => {
    expect(parseEpisodeResponse({ seriesTitle: 'x', episodes: [{ fromWord: 10, toWord: 5, title: '' }] }, words, durationMs, 'G')).toBeNull()
    expect(parseEpisodeResponse('nope', words, durationMs, 'G')).toBeNull()
  })
})
