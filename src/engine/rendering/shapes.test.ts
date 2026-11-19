import { describe, expect, it } from 'vitest'
import type { EmojiLayer, ShapeLayer } from '@shared/models/project'
import { SHAPE_KINDS } from '@shared/models/project'
import type { PathTarget } from './shapes'
import { EMOJI_PICKS, SHAPES, elementProportions, firstEmoji, layerLabel, shapeSvgPath, strokeWidthOf, traceShape } from './shapes'

/** Records the calls a shape makes while it is traced. */
function recorder(): PathTarget & { calls: string[] } {
  const calls: string[] = []
  const record =
    (name: string) =>
    (...args: number[]) =>
      calls.push(`${name}(${args.map((value) => Math.round(value * 100) / 100).join(',')})`)
  return {
    calls,
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    bezierCurveTo: record('bezierCurveTo'),
    ellipse: record('ellipse'),
    roundRect: record('roundRect'),
    closePath: record('closePath')
  }
}

const box = { x: 10, y: 20, width: 100, height: 50 }

const shape = (change: Partial<ShapeLayer> = {}): ShapeLayer => ({
  id: 'shape-1',
  kind: 'shape',
  shape: 'rectangle',
  startMs: 0,
  endMs: 1000,
  position: { x: 0.5, y: 0.5 },
  sizeRatio: 0.2,
  rotationDeg: 0,
  opacity: 1,
  cornerRadiusRatio: 0,
  aspect: 0.6,
  fill: true,
  fillColor: '#ff0000',
  strokeRatio: 0,
  strokeColor: '#ffffff',
  ...change
})

describe('SHAPES', () => {
  it('describes every shape kind once, in the model order', () => {
    expect(SHAPES.map((info) => info.kind)).toEqual(SHAPE_KINDS)
  })
})

describe('traceShape', () => {
  it('traces a rectangle as a rounded rect, the radius capped at half the shorter side', () => {
    const path = recorder()
    traceShape(path, 'rectangle', box, 40)
    expect(path.calls).toEqual(['roundRect(10,20,100,50,25)'])
  })

  it('traces a line like a rectangle, so its corners make the ends', () => {
    const path = recorder()
    traceShape(path, 'line', box, 0)
    expect(path.calls).toEqual(['roundRect(10,20,100,50,0)'])
  })

  it('traces an ellipse centred in the box', () => {
    const path = recorder()
    traceShape(path, 'ellipse', box, 0)
    expect(path.calls).toEqual(['ellipse(60,45,50,25,0,0,6.28)', 'closePath()'])
  })

  it('traces a closed polygon for the triangle, the diamond, the arrow and the star', () => {
    for (const [kind, corners] of [
      ['triangle', 3],
      ['diamond', 4],
      ['arrow', 7],
      ['star', 10]
    ] as const) {
      const path = recorder()
      traceShape(path, kind, box, 0)
      expect(path.calls[0], kind).toMatch(/^moveTo/)
      expect(path.calls.filter((call) => call.startsWith('lineTo')), kind).toHaveLength(corners - 1)
      expect(path.calls.at(-1), kind).toBe('closePath()')
    }
  })

  it('points the triangle up and the arrow right, filling the box', () => {
    const triangle = recorder()
    traceShape(triangle, 'triangle', box, 0)
    expect(triangle.calls[0]).toBe('moveTo(60,20)')
    const arrow = recorder()
    traceShape(arrow, 'arrow', box, 0)
    expect(arrow.calls).toContain('lineTo(110,45)')
    expect(arrow.calls[0]).toBe('moveTo(10,35)')
  })

  it('traces the heart with curves, closed', () => {
    const path = recorder()
    traceShape(path, 'heart', box, 0)
    expect(path.calls.filter((call) => call.startsWith('bezierCurveTo'))).toHaveLength(4)
    expect(path.calls.at(-1)).toBe('closePath()')
  })
})

describe('shapeSvgPath', () => {
  it('writes every shape as an SVG path inside the box', () => {
    for (const kind of SHAPE_KINDS) {
      const d = shapeSvgPath(kind, box, 6)
      expect(d, kind).toMatch(/^M/)
      expect(d, kind).toMatch(/Z$/)
    }
  })

  it('writes a plain rectangle without arcs and a rounded one with them', () => {
    expect(shapeSvgPath('rectangle', box, 0)).toBe('M10 20H110V70H10Z')
    expect(shapeSvgPath('rectangle', box, 5)).toContain('A5 5 0 0 1')
  })
})

describe('strokeWidthOf', () => {
  it('is the share of the output height, at least a pixel, and nothing when the ratio is 0', () => {
    expect(strokeWidthOf(shape({ strokeRatio: 0.01 }), 1080)).toBeCloseTo(10.8)
    expect(strokeWidthOf(shape({ strokeRatio: 0.0001 }), 1080)).toBe(1)
    expect(strokeWidthOf(shape({ strokeRatio: 0 }), 1080)).toBe(0)
  })
})

describe('firstEmoji', () => {
  it('takes the first grapheme typed, whole, and nothing from blank text', () => {
    expect(firstEmoji(' 🚀🔥 ')).toBe('🚀')
    expect(firstEmoji('👨‍👩‍👧 ok')).toBe('👨‍👩‍👧')
    expect(firstEmoji('🇧🇷')).toBe('🇧🇷')
    expect(firstEmoji('   ')).toBeNull()
    expect(firstEmoji('')).toBeNull()
  })

  it('offers only single emojis in the picks', () => {
    for (const emoji of EMOJI_PICKS) expect(firstEmoji(emoji), emoji).toBe(emoji)
    expect(new Set(EMOJI_PICKS).size).toBe(EMOJI_PICKS.length)
  })
})

describe('layerLabel and elementProportions', () => {
  const emoji: EmojiLayer = { ...shape(), kind: 'emoji', emoji: '👍' } as unknown as EmojiLayer

  it('names a shape by its kind, an emoji by itself and a file by its name', () => {
    expect(layerLabel(shape({ shape: 'arrow' }), () => 'x')).toBe('Seta')
    expect(layerLabel(emoji, () => 'x')).toBe('👍')
    expect(layerLabel({ ...shape(), kind: 'image', file: 'logo.png' } as never, (file) => `named ${file}`)).toBe('named logo.png')
  })

  it('lays a shape out by its aspect and an emoji as a square', () => {
    expect(elementProportions(shape({ aspect: 0.25 }))).toEqual({ width: 1, height: 0.25 })
    expect(elementProportions(emoji)).toEqual({ width: 1, height: 1 })
  })
})
