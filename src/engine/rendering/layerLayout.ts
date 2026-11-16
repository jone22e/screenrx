import type { Layer } from '@shared/models/project'
import type { Rect, Size } from './frameLayout'

/** Where an image layer sits on the output, in output pixels, before its rotation. */
export interface ImageLayerLayout extends Rect {
  cornerRadius: number
  rotationDeg: number
}

/**
 * Lays out an image: as wide as its share of the output width, as tall as
 * its own proportions say, centred on its position. An image may hang over
 * the edge — a sticker half out of frame is a choice — but its centre stays
 * inside the output, so it can always be grabbed.
 */
export function layoutImageLayer(output: Size, layer: Layer, image: Size): ImageLayerLayout {
  const width = Math.max(1, layer.sizeRatio * output.width)
  const height = image.width > 0 && image.height > 0 ? (width * image.height) / image.width : width
  const centerX = Math.min(Math.max(layer.position.x, 0), 1) * output.width
  const centerY = Math.min(Math.max(layer.position.y, 0), 1) * output.height
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    cornerRadius: Math.min(width, height) * layer.cornerRadiusRatio,
    rotationDeg: layer.rotationDeg
  }
}

/** The layers on screen at `timeMs` (source time), bottom first: the order they are drawn in. */
export function layersAt(layers: readonly Layer[], timeMs: number): Layer[] {
  return layers.filter((layer) => timeMs >= layer.startMs && timeMs < layer.endMs)
}

/** The axis-aligned box a rotated layout covers, for finding what is under the pointer. */
export function rotatedBounds(layout: ImageLayerLayout): Rect {
  const angle = (layout.rotationDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const width = layout.width * cos + layout.height * sin
  const height = layout.width * sin + layout.height * cos
  const centerX = layout.x + layout.width / 2
  const centerY = layout.y + layout.height / 2
  return { x: centerX - width / 2, y: centerY - height / 2, width, height }
}
