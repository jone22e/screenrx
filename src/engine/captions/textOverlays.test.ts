import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT_STYLE } from '@shared/models/project'
import { textsAt } from './textOverlays'

const text = (id: string, startMs: number, endMs: number, content = id) => ({ id, startMs, endMs, text: content, style: DEFAULT_TEXT_STYLE })

describe('textsAt', () => {
  it('returns the texts whose span covers the instant, overlapping ones included, in order', () => {
    const texts = [text('a', 0, 2000), text('b', 1000, 3000), text('c', 5000, 6000)]
    expect(textsAt(texts, 1500).map((t) => t.id)).toEqual(['a', 'b'])
    expect(textsAt(texts, 2000).map((t) => t.id)).toEqual(['b'])
    expect(textsAt(texts, 4000)).toEqual([])
  })

  it('leaves out a text with nothing written', () => {
    expect(textsAt([text('a', 0, 2000, '   ')], 500)).toEqual([])
  })
})
