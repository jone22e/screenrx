import { describe, expect, it } from 'vitest'
import type { ImageLayer } from '@shared/models/project'
import { layersAt, layoutImageLayer, rotatedBounds } from './layerLayout'

const layer = (change: Partial<ImageLayer> = {}): ImageLayer => ({
  id: 'logo',
  kind: 'image',
  file: 'logo.png',
  startMs: 0,
  endMs: 10_000,
  position: { x: 0.5, y: 0.5 },
  sizeRatio: 0.2,
  rotationDeg: 0,
  opacity: 1,
  cornerRadiusRatio: 0,
  ...change
})
const output = { width: 1000, height: 500 }

describe('layoutImageLayer', () => {
  it('sizes the image by its share of the output width, keeping its proportions', () => {
    const layout = layoutImageLayer(output, layer(), { width: 400, height: 200 })
    expect(layout).toEqual({ x: 400, y: 200, width: 200, height: 100, cornerRadius: 0, rotationDeg: 0 })
  })

  it('places the centre where asked, even hanging over the edge, and rounds the corners from the shorter side', () => {
    const layout = layoutImageLayer(output, layer({ position: { x: 0, y: 1 }, cornerRadiusRatio: 0.5 }), { width: 100, height: 300 })
    expect(layout.x).toBe(-100)
    expect(layout.y).toBe(500 - 300)
    expect(layout.cornerRadius).toBe(100)
  })

  it('takes a square for an image whose size is unknown', () => {
    const layout = layoutImageLayer(output, layer(), { width: 0, height: 0 })
    expect([layout.width, layout.height]).toEqual([200, 200])
  })
})

describe('layersAt', () => {
  it('keeps the layers on screen at the instant, in their order', () => {
    const layers = [layer({ id: 'a', startMs: 0, endMs: 1000 }), layer({ id: 'b', startMs: 500, endMs: 2000 })]
    expect(layersAt(layers, 700).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(layersAt(layers, 1000).map((entry) => entry.id)).toEqual(['b'])
    expect(layersAt(layers, 3000)).toEqual([])
  })
})

describe('rotatedBounds', () => {
  it('is the layout itself unrotated and grows with the rotation', () => {
    const layout = { x: 100, y: 100, width: 200, height: 100, cornerRadius: 0, rotationDeg: 0 }
    expect(rotatedBounds(layout)).toEqual({ x: 100, y: 100, width: 200, height: 100 })
    const turned = rotatedBounds({ ...layout, rotationDeg: 90 })
    expect(turned.width).toBeCloseTo(100)
    expect(turned.height).toBeCloseTo(200)
    expect(turned.x).toBeCloseTo(150)
    expect(turned.y).toBeCloseTo(50)
  })
})
