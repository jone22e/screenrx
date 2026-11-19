import { describe, expect, it } from 'vitest'
import { DEFAULT_SPLIT, parseSplitScreen } from '@shared/models/project'
import { applyLayoutSpan, coverCrop, layoutSplit, splitAt } from './splitScreen'

const reels = { width: 1080, height: 1920 }

describe('layoutSplit', () => {
  it('stacks the recording over the clip, or the other way round, meeting at the seam', () => {
    const split = layoutSplit(reels, { ...DEFAULT_SPLIT, mainShare: 0.6, dividerRatio: 0.01 })
    expect(split.main).toEqual({ x: 0, y: 0, width: 1080, height: 1152 })
    expect(split.clip).toEqual({ x: 0, y: 1152, width: 1080, height: 768 })
    expect(split.divider).toEqual({ x: 0, y: 1152 - 5.5, width: 1080, height: 11 })
    const flipped = layoutSplit(reels, { ...DEFAULT_SPLIT, clipFirst: true, dividerRatio: 0 })
    expect(flipped.clip).toEqual({ x: 0, y: 0, width: 1080, height: 960 })
    expect(flipped.main.y).toBe(960)
    expect(flipped.divider).toBeNull()
  })

  it('puts them side by side', () => {
    const split = layoutSplit({ width: 1920, height: 1080 }, { ...DEFAULT_SPLIT, orientation: 'side' })
    expect(split.main).toEqual({ x: 0, y: 0, width: 960, height: 1080 })
    expect(split.clip).toEqual({ x: 960, y: 0, width: 960, height: 1080 })
  })
})

describe('coverCrop', () => {
  it('cuts a wide picture to a wide-but-shorter box sideways, centred on the focus and kept inside', () => {
    // 1080 × 960 box from a 1920 × 1080 recording: the full height, 1215 px of the width.
    const crop = coverCrop({ width: 1080, height: 960 }, { width: 1920, height: 1080 }, { x: 0.5, y: 0.5 })
    expect(crop.height).toBe(1)
    expect(crop.width).toBeCloseTo(1215 / 1920, 5)
    expect(crop.x).toBeCloseTo((1 - crop.width) / 2, 5)
    expect(coverCrop({ width: 1080, height: 960 }, { width: 1920, height: 1080 }, { x: 0, y: 0.5 }).x).toBe(0)
    // A tall phone video in a wide box: cut top and bottom.
    const tall = coverCrop({ width: 1080, height: 960 }, { width: 1080, height: 1920 }, { x: 0.5, y: 0.2 })
    expect(tall.width).toBe(1)
    expect(tall.y).toBe(0)
  })
})

describe('splitAt / parseSplitScreen', () => {
  it('finds the split layer whose span holds the instant, and reads settings back within limits', () => {
    const layers = [
      { id: 'a', kind: 'video', startMs: 0, endMs: 1000 },
      { id: 'b', kind: 'video', startMs: 500, endMs: 3000, split: DEFAULT_SPLIT }
    ]
    expect(splitAt(layers, 400)).toBeNull()
    expect(splitAt(layers, 600)?.id).toBe('b')
    expect(splitAt(layers, 3000)).toBeNull()
    expect(parseSplitScreen({ mainShare: 5, audio: 'nope', dividerColor: 'red', orientation: 'side' })).toMatchObject({ mainShare: 0.8, audio: 'both', dividerColor: '#000000', orientation: 'side' })
    expect(parseSplitScreen(null)).toBeUndefined()
  })
})

describe('applyLayoutSpan', () => {
  let next = 0
  const newId = (): string => `new-${++next}`
  const clip = { id: 'v', kind: 'video', file: 'reacao.mp4', startMs: 1000, endMs: 11_000, offsetMs: 500, split: { ...DEFAULT_SPLIT } }
  const other = { id: 'img', kind: 'image', file: 'logo.png', startMs: 0, endMs: 20_000 }

  it('cuts the second video at the stretch, keeping it in step, and sets what the stretch shows', () => {
    const layers = applyLayoutSpan([other, clip], 'reacao.mp4', { startMs: 4000, endMs: 6000 }, 'clip', DEFAULT_SPLIT, newId)
    const pieces = layers.filter((layer) => layer.kind === 'video') as Array<typeof clip & { split: { show?: string } }>
    expect(pieces.map((piece) => [piece.startMs, piece.endMs, piece.offsetMs, piece.split.show ?? 'both'])).toEqual([
      [1000, 4000, 500, 'both'],
      [4000, 6000, 3500, 'clip'],
      [6000, 11_000, 5500, 'both']
    ])
    expect(pieces[0]?.id).toBe('v')
    expect(layers[0]).toBe(other)
  })

  it('joins the pieces again when the stretch goes back to how it was, and leaves times without video 2 alone', () => {
    const split = applyLayoutSpan([clip], 'reacao.mp4', { startMs: 4000, endMs: 6000 }, 'main', DEFAULT_SPLIT, newId)
    const back = applyLayoutSpan(split, 'reacao.mp4', { startMs: 3000, endMs: 7000 }, 'both', DEFAULT_SPLIT, newId)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ startMs: 1000, endMs: 11_000, offsetMs: 500 })
    expect(applyLayoutSpan([clip], 'reacao.mp4', { startMs: 12_000, endMs: 14_000 }, 'clip', DEFAULT_SPLIT, newId)).toEqual([clip])
  })

  it('splits a floating clip only where it is told to', () => {
    const floating = { ...clip, split: undefined }
    delete (floating as { split?: unknown }).split
    const layers = applyLayoutSpan([floating], 'reacao.mp4', { startMs: 0, endMs: 3000 }, 'both', DEFAULT_SPLIT, newId) as Array<{ startMs: number; split?: unknown }>
    expect(layers.map((layer) => [layer.startMs, layer.split !== undefined])).toEqual([
      [1000, true],
      [3000, false]
    ])
  })
})

describe('layoutSplit with only the clip', () => {
  it('gives the clip the whole frame', () => {
    const only = layoutSplit(reels, { ...DEFAULT_SPLIT, show: 'clip' })
    expect(only.clip).toEqual({ x: 0, y: 0, width: 1080, height: 1920 })
    expect(only.main.width).toBe(0)
    expect(only.divider).toBeNull()
  })
})
