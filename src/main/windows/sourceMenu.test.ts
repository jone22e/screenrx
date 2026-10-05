import { describe, expect, it, vi } from 'vitest'
import type { DisplaySource } from '@shared/models/capture'

vi.mock('electron', () => ({ Menu: {}, nativeImage: {} }))

const { displayDetail, placementOf } = await import('./sourceMenu')

const display: DisplaySource = {
  kind: 'display',
  id: 'display:1',
  displayId: 1,
  index: 1,
  name: 'Tela integrada',
  isMain: true,
  widthPx: 3024,
  heightPx: 1964,
  scaleFactor: 2,
  thumbnailDataUrl: null
}

describe('displayDetail', () => {
  it('gives the size in points, as System Settings shows it', () => {
    expect(displayDetail({ ...display, isMain: false }, null)).toBe('1512 × 982')
    expect(displayDetail({ ...display, isMain: false, widthPx: 3440, heightPx: 1440, scaleFactor: 1 }, null)).toBe('3440 × 1440')
  })

  it('says which display is the main one and which has the recording bar', () => {
    expect(displayDetail(display, null)).toBe('1512 × 982 · principal')
    expect(displayDetail(display, 1)).toBe('1512 × 982 · principal · onde está esta barra')
    expect(displayDetail({ ...display, isMain: false }, 7)).toBe('1512 × 982')
  })
})

describe('placementOf', () => {
  // Two ultrawides stacked, with a laptop to the right of the lower one (the main display).
  const arrangement = [
    { displayId: 2, bounds: { x: 0, y: 0, width: 3440, height: 1440 } },
    { displayId: 3, bounds: { x: 0, y: -1440, width: 3440, height: 1440 } },
    { displayId: 1, bounds: { x: 3440, y: 271, width: 1800, height: 1169 } }
  ]

  it('says where a display sits next to the main one', () => {
    expect(placementOf(3, 2, arrangement)).toBe('acima da principal')
    expect(placementOf(1, 2, arrangement)).toBe('à direita da principal')
    expect(placementOf(2, 3, arrangement)).toBe('abaixo da principal')
    expect(placementOf(2, 1, arrangement)).toBe('à esquerda da principal')
  })

  it('says nothing about the main display, or about one it cannot place', () => {
    expect(placementOf(2, 2, arrangement)).toBeNull()
    expect(placementOf(9, 2, arrangement)).toBeNull()
    expect(placementOf(3, null, arrangement)).toBeNull()
  })

  it('goes into the detail in place of "principal"', () => {
    const other = { ...display, displayId: 3, isMain: false }
    expect(displayDetail(other, 3, placementOf(3, 2, arrangement))).toBe('1512 × 982 · acima da principal · onde está esta barra')
    expect(displayDetail(display, null, 'acima da principal')).toBe('1512 × 982 · principal')
  })
})
