import { describe, expect, it } from 'vitest'
import { normalizeHashtag, parseCaptionSuggestion } from './instagram'

describe('parseCaptionSuggestion', () => {
  it('tidies the hashtags and puts the missing ones at the end of the caption', () => {
    const parsed = parseCaptionSuggestion(
      {
        topic: 'GTA 6',
        caption: 'O novo trailer de GTA 6 chegou! #GTA6',
        hashtags: ['#GTA6', 'gta 6 trailer', '#GTA6', '##ViceCity', 'não!'],
        trends: [{ term: 'trailer 3', why: 'Lançado em 18/11' }, { term: '', why: 'x' }],
        sources: ['https://example.com/a', 'javascript:alert(1)', 'https://example.com/a (dated July 2026; not read)']
      },
      'Título'
    )
    expect(parsed?.hashtags).toEqual(['#gta6', '#gta6trailer', '#vicecity', '#não'])
    expect(parsed?.caption).toBe('O novo trailer de GTA 6 chegou! #GTA6\n\n#gta6trailer #vicecity #não')
    expect(parsed?.trends).toEqual([{ term: 'trailer 3', why: 'Lançado em 18/11' }])
    expect(parsed?.sources).toEqual(['https://example.com/a'])
  })

  it('falls back to the given topic and refuses an empty caption', () => {
    expect(parseCaptionSuggestion({ caption: 'Oi', hashtags: [], trends: [], sources: [] }, 'GTA 6')?.topic).toBe('GTA 6')
    expect(parseCaptionSuggestion({ caption: '  ' }, 'x')).toBeNull()
    expect(normalizeHashtag('#')).toBeNull()
  })
})
