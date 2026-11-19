import { describe, expect, it } from 'vitest'
import { CAPTION_FONTS } from '@engine/captions/captionConfig'
import { DEFAULT_TEXT_STYLE } from '@shared/models/project'
import { TEXT_LOOKS, applyTextLook, hasTextLook } from './textLooks'

describe('text looks', () => {
  it('are distinct, named, and use fonts the editor has', () => {
    const ids = TEXT_LOOKS.map((look) => look.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const look of TEXT_LOOKS) {
      expect(look.label).not.toBe('')
      expect(CAPTION_FONTS[look.style.font]).toBeDefined()
      expect(look.style.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(look.style.backdropColor).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('dresses a style without moving or resizing it', () => {
    const style = { ...DEFAULT_TEXT_STYLE, sizeRatio: 0.07, position: { x: 0.2, y: 0.8 } }
    const yellow = TEXT_LOOKS.find((look) => look.id === 'yellow')!
    const dressed = applyTextLook(style, yellow)
    expect(dressed).toMatchObject({ font: 'impact', uppercase: true, color: '#ffe14d', backdrop: 'outline', sizeRatio: 0.07, position: { x: 0.2, y: 0.8 } })
    expect(dressed.position).not.toBe(style.position)
    expect(hasTextLook(dressed, yellow)).toBe(true)
    expect(hasTextLook(style, yellow)).toBe(false)
    // Changing a colour by hand takes the look off.
    expect(hasTextLook({ ...dressed, color: '#ffffff' }, yellow)).toBe(false)
  })
})
