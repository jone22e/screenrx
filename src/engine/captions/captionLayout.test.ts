import { describe, expect, it } from 'vitest'
import type { CaptionStyle } from '@shared/models/project'
import { DEFAULT_CAPTION_STYLE } from '@shared/models/project'
import { CAPTION_LAYOUT } from './captionConfig'
import { captionDisplayText, captionFontCss, captionPieces, layoutCaption } from './captionLayout'

const output = { width: 1920, height: 1080 }
const style = (change: Partial<CaptionStyle> = {}): CaptionStyle => ({ ...DEFAULT_CAPTION_STYLE, ...change })
/** A monospaced stand-in for the canvas: every character is 20 px wide. */
const measure = (text: string): number => text.length * 20

describe('captionDisplayText', () => {
  it('collapses spacing and applies upper case', () => {
    expect(captionDisplayText('  olá   mundo ', style())).toBe('olá mundo')
    expect(captionDisplayText('olá mundo', style({ uppercase: true }))).toBe('OLÁ MUNDO')
  })
})

describe('captionFontCss', () => {
  it('describes weight, size and family', () => {
    expect(captionFontCss(style({ font: 'serif', bold: false }), 40)).toBe('500 40px Georgia, "Times New Roman", serif')
    expect(captionFontCss(style({ font: 'serif', bold: true }), 40)).toMatch(/^700 40px /)
  })
})

describe('layoutCaption', () => {
  it('returns nothing for empty text', () => {
    expect(layoutCaption('   ', style(), output, measure)).toBeNull()
  })

  it('sizes the font from the output height', () => {
    expect(layoutCaption('oi', style({ sizeRatio: 0.05 }), output, measure)?.fontPx).toBe(54)
    expect(layoutCaption('oi', style({ sizeRatio: 0.05 }), { width: 1280, height: 720 }, measure)?.fontPx).toBe(36)
  })

  it('keeps a short caption on one line, centred on its position', () => {
    const layout = layoutCaption('olá mundo', style({ position: { x: 0.5, y: 0.5 } }), output, measure)
    expect(layout?.lines).toHaveLength(1)
    expect(layout?.lines[0]?.centerX).toBeCloseTo(960)
    expect(layout?.lines[0]?.centerY).toBeCloseTo(540)
    expect(layout && layout.box.x + layout.box.width / 2).toBeCloseTo(960)
  })

  it('wraps to the allowed width with lines of similar length', () => {
    // 99 characters: too wide for one line of 76 (1536 px), so two balanced lines.
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt'
    const layout = layoutCaption(text, style(), output, measure)
    expect(layout?.lines).toHaveLength(2)
    const widths = layout?.lines.map((line) => measure(line.text)) ?? []
    expect(Math.max(...widths)).toBeLessThanOrEqual(output.width * CAPTION_LAYOUT.maxWidthRatio)
    expect(Math.abs((widths[0] ?? 0) - (widths[1] ?? 0))).toBeLessThanOrEqual(5 * 20)
    expect(layout?.lines.map((line) => line.text).join(' ')).toBe(text)
  })

  it('keeps the caption inside the output wherever it is placed', () => {
    for (const position of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 0 }
    ]) {
      const box = layoutCaption('uma legenda qualquer', style({ position }), output, measure)?.box
      expect(box).toBeDefined()
      if (!box) continue
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(output.width)
      expect(box.y + box.height).toBeLessThanOrEqual(output.height)
    }
  })

  it('is the same layout at any resolution', () => {
    const big = layoutCaption('olá mundo', style(), output, measure)
    // Text measured at half the font size is half as wide.
    const small = layoutCaption('olá mundo', style(), { width: 960, height: 540 }, (text) => measure(text) / 2)
    expect(small && big && small.box.x / 960).toBeCloseTo((big?.box.x ?? 0) / 1920)
    expect(small && big && small.box.width / 960).toBeCloseTo((big?.box.width ?? 0) / 1920)
    expect(small && big && small.box.y / 540).toBeCloseTo((big?.box.y ?? 0) / 1080)
  })
})

describe('captionPieces', () => {
  it('breaks languages written with spaces between words', () => {
    expect(captionPieces('olá mundo, tudo bem?')).toEqual([
      { text: 'olá', spaced: true, wordIndex: 0 },
      { text: 'mundo,', spaced: true, wordIndex: 1 },
      { text: 'tudo', spaced: true, wordIndex: 2 },
      { text: 'bem?', spaced: true, wordIndex: 3 }
    ])
  })

  it('tells which word each character of Chinese belongs to', () => {
    expect(captionPieces('大家 好').map((piece) => piece.wordIndex)).toEqual([0, 0, 1])
  })

  it('breaks Chinese between characters, keeping punctuation with what it closes', () => {
    expect(captionPieces('大家好，今天').map((piece) => piece.text)).toEqual(['大', '家', '好，', '今', '天'])
    expect(captionPieces('大家好，今天').every((piece, index) => piece.spaced === (index === 0))).toBe(true)
  })

  it('keeps a word in Latin letters whole inside Chinese text', () => {
    expect(captionPieces('导出 MP4 视频').map((piece) => piece.text)).toEqual(['导', '出', 'MP4', '视', '频'])
  })
})

describe('layoutCaption pieces', () => {
  it('places each word where it falls in its line', () => {
    const layout = layoutCaption('olá mundo', style({ position: { x: 0.5, y: 0.5 } }), output, measure)
    const line = layout?.lines[0]
    // "olá mundo" is 9 characters: 180 px, from 870 to 1050.
    expect(line?.pieces.map((piece) => [piece.text, piece.wordIndex, piece.centerX, piece.width])).toEqual([
      ['olá', 0, 900, 60],
      ['mundo', 1, 1000, 100]
    ])
  })

  it('keeps the word index across wrapped lines', () => {
    const text = Array.from({ length: 20 }, (_, index) => `palavra${index}`).join(' ')
    const layout = layoutCaption(text, style(), output, measure)
    const indices = layout?.lines.flatMap((line) => line.pieces.map((piece) => piece.wordIndex))
    expect(indices).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })
})

describe('layoutCaption in a language without spaces', () => {
  it('wraps Chinese to the allowed width and loses no character', () => {
    // 100 characters of 20 px: 2000 px, wider than the 1536 px allowed.
    const text = '今天我们来看看如何导出视频'.repeat(8).slice(0, 100)
    const layout = layoutCaption(text, style(), output, measure)
    expect(layout?.lines.length).toBe(2)
    expect(layout?.lines.map((line) => line.text).join('')).toBe(text)
    for (const line of layout?.lines ?? []) expect(measure(line.text)).toBeLessThanOrEqual(1536)
  })
})
