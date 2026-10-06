import type { CaptionStyle } from '@shared/models/project'
import type { Rect, Size } from '../rendering/frameLayout'
import { CAPTION_FONTS, CAPTION_LAYOUT } from './captionConfig'

export interface CaptionLine {
  text: string
  /** Centre of the line, in output pixels. */
  centerX: number
  centerY: number
}

/** Where a caption sits on the output, in output pixels. */
export interface CaptionLayout {
  fontPx: number
  lines: CaptionLine[]
  /** The block behind the text: its backdrop, and what the user grabs to move it. */
  box: Rect
  boxRadius: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/** The text as it is shown: single-spaced, and upper-cased when the style says so. */
export function captionDisplayText(text: string, style: CaptionStyle): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return style.uppercase ? clean.toLocaleUpperCase() : clean
}

export function captionFontPx(style: CaptionStyle, output: Size): number {
  return style.sizeRatio * output.height
}

/** The CSS font of a caption at `fontPx`, for a canvas context. */
export function captionFontCss(style: CaptionStyle, fontPx: number): string {
  return `${style.bold ? 700 : 500} ${fontPx}px ${CAPTION_FONTS[style.font].family}`
}

/** A piece of text a line may end after, and whether a space separates it from the piece before. */
interface Piece {
  text: string
  spaced: boolean
}

/** Chinese, Japanese and Korean are written without spaces: a line may break between any two characters. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/
/** Punctuation that must stay on the line of the character before it. */
const CLOSING = /^[，。！？、；：）」』】》〉,.!?;:)\]]/

/**
 * Splits a caption into the pieces lines are made of: words, for languages
 * written with spaces; single characters, for those written without.
 */
export function captionPieces(text: string): Piece[] {
  const pieces: Piece[] = []
  text.split(' ').forEach((word) => {
    let current = ''
    let spaced = true
    const flush = (): void => {
      if (current === '') return
      pieces.push({ text: current, spaced })
      current = ''
      spaced = false
    }
    for (const character of word) {
      if (CJK.test(character)) {
        flush()
        pieces.push({ text: character, spaced })
        spaced = false
      } else if (CLOSING.test(character) && current === '' && pieces.length > 0 && !spaced) {
        // Closing punctuation never starts a line: it joins the piece before it.
        const previous = pieces[pieces.length - 1]
        if (previous) previous.text += character
      } else {
        current += character
      }
    }
    flush()
  })
  return pieces
}

/** Breaks the pieces into lines no wider than `maxWidth`; a piece wider than that gets a line of its own. */
function wrap(pieces: readonly Piece[], maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const piece of pieces) {
    const candidate = line === '' ? piece.text : `${line}${piece.spaced ? ' ' : ''}${piece.text}`
    if (line !== '' && measure(candidate) > maxWidth) {
      lines.push(line)
      line = piece.text
    } else {
      line = candidate
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

/**
 * Lays out one caption: wrapped to the allowed width, with lines of similar
 * length, centred on the style's position and kept inside the output.
 *
 * `measure` returns the width of a text in output pixels, in the caption's
 * font (`captionFontCss` at `captionFontPx`).
 */
export function layoutCaption(
  text: string,
  style: CaptionStyle,
  output: Size,
  measure: (text: string) => number
): CaptionLayout | null {
  const shown = captionDisplayText(text, style)
  if (shown === '') return null
  const fontPx = captionFontPx(style, output)
  const words = captionPieces(shown)
  const maxWidth = output.width * CAPTION_LAYOUT.maxWidthRatio

  // Balance: with the line count settled, narrow the lines as far as that count allows,
  // so a caption reads as two similar lines rather than a long one and a leftover word.
  let lines = wrap(words, maxWidth, measure)
  if (lines.length > 1) {
    const lineCount = lines.length
    let narrow = maxWidth / lineCount
    let wide = maxWidth
    for (let step = 0; step < 12; step++) {
      const candidate = (narrow + wide) / 2
      const wrapped = wrap(words, candidate, measure)
      const fits = wrapped.length <= lineCount && wrapped.every((line) => measure(line) <= maxWidth)
      if (fits) {
        wide = candidate
        lines = wrapped
      } else {
        narrow = candidate
      }
    }
  }

  const textWidth = Math.max(...lines.map(measure))
  const lineHeight = fontPx * CAPTION_LAYOUT.lineHeight
  const width = Math.min(textWidth + 2 * fontPx * CAPTION_LAYOUT.boxPaddingX, output.width)
  const height = Math.min(lines.length * lineHeight + 2 * fontPx * CAPTION_LAYOUT.boxPaddingY, output.height)
  const margin = Math.min(output.height * CAPTION_LAYOUT.edgeMarginRatio, (output.height - height) / 2)
  const marginX = Math.min(margin, (output.width - width) / 2)
  const x = clamp(style.position.x * output.width - width / 2, marginX, output.width - width - marginX)
  const y = clamp(style.position.y * output.height - height / 2, margin, output.height - height - margin)
  const firstLineY = y + height / 2 - ((lines.length - 1) * lineHeight) / 2

  return {
    fontPx,
    lines: lines.map((line, index) => ({
      text: line,
      centerX: x + width / 2,
      centerY: firstLineY + index * lineHeight
    })),
    box: { x, y, width, height },
    boxRadius: fontPx * CAPTION_LAYOUT.boxRadius
  }
}
