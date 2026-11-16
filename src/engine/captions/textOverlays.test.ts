import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT_MOTION, DEFAULT_TEXT_STYLE } from '@shared/models/project'
import { textsAt } from './textOverlays'

const text = (id: string, startMs: number, endMs: number, content = id) => ({ id, startMs, endMs, text: content, style: DEFAULT_TEXT_STYLE, enter: DEFAULT_TEXT_MOTION, exit: DEFAULT_TEXT_MOTION })

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

describe('textsWithMotionAt', () => {
  it('transforms each text by its entrance or exit at the instant', async () => {
    const { textsWithMotionAt } = await import('./textOverlays')
    const fading = { ...text('a', 1000, 3000), enter: { kind: 'fade' as const, durationMs: 400 }, exit: { kind: 'fade' as const, durationMs: 400 } }
    expect(textsWithMotionAt([fading], 1200)[0]?.motion.alpha).toBeCloseTo(0.5)
    expect(textsWithMotionAt([fading], 2000)[0]?.motion.alpha).toBe(1)
    expect(textsWithMotionAt([fading], 2900)[0]?.motion.alpha).toBeLessThan(0.5)
  })
})
