import { describe, expect, it } from 'vitest'
import { CAPTION_POSITIONS } from '../captions/captionConfig'
import { captionPlacementOf, captionPlacementY, safeZones } from './safeZones'

describe('safeZones', () => {
  it('marks the covered bands of a vertical video and nothing elsewhere', () => {
    const bands = safeZones('9:16')
    expect(bands.map((band) => band.label)).toEqual(['Topo do app', 'Legenda e música do app', 'Botões'])
    for (const band of bands) {
      expect(band.x + band.width).toBeLessThanOrEqual(1)
      expect(band.y + band.height).toBeLessThanOrEqual(1)
    }
    expect(safeZones('native')).toEqual([])
    expect(safeZones('1:1')).toEqual([])
  })
})

describe('captionPlacementY', () => {
  it('keeps the bottom caption of a vertical video above the app caption band', () => {
    const bottom = safeZones('9:16').find((band) => band.y > 0.5) as { y: number }
    expect(captionPlacementY('bottom', '9:16')).toBeLessThan(bottom.y)
    expect(captionPlacementY('top', '9:16')).toBeGreaterThan(0.1)
    expect(captionPlacementY('middle', '9:16')).toBe(0.5)
  })

  it('uses the usual places for other shapes', () => {
    expect(captionPlacementY('bottom', 'native')).toBe(CAPTION_POSITIONS.bottom)
    expect(captionPlacementY('top', '4:5')).toBe(CAPTION_POSITIONS.top)
  })

  it('recognizes a placement for the shape in use', () => {
    expect(captionPlacementOf({ x: 0.5, y: 0.72 }, '9:16')).toBe('bottom')
    expect(captionPlacementOf({ x: 0.5, y: 0.72 }, 'native')).toBeNull()
    expect(captionPlacementOf({ x: 0.5, y: CAPTION_POSITIONS.bottom }, 'native')).toBe('bottom')
    expect(captionPlacementOf({ x: 0.4, y: 0.5 }, 'native')).toBeNull()
  })
})
