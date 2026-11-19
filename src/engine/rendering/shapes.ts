import type { ElementLayer, Layer, ShapeKind, ShapeLayer } from '@shared/models/project'
import { SHAPE_LIMITS } from '@shared/models/project'
import type { Rect } from './frameLayout'

/**
 * The shapes drawn over the video, traced the same way for the canvas, for
 * the panel's icons (as SVG) and for the tests: a path is built on whatever
 * can take these calls.
 */
export interface PathTarget {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void
  roundRect(x: number, y: number, width: number, height: number, radius: number): void
  closePath(): void
}

export interface ShapeInfo {
  kind: ShapeKind
  label: string
  hint: string
  /** Height over width as added. */
  aspect: number
  /** Corner rounding as added (the line is a pill). */
  cornerRadiusRatio: number
  /** Whether the corner rounding means anything for it. */
  rounded: boolean
}

export const SHAPES: readonly ShapeInfo[] = [
  { kind: 'rectangle', label: 'Retângulo', hint: 'Uma caixa: cheia, ou só o contorno em volta de algo.', aspect: 0.6, cornerRadiusRatio: 0.08, rounded: true },
  { kind: 'ellipse', label: 'Círculo', hint: 'Um círculo, ou uma elipse ao mudar a altura.', aspect: 1, cornerRadiusRatio: 0, rounded: false },
  { kind: 'triangle', label: 'Triângulo', hint: 'Aponta para cima; gire para apontar para onde quiser.', aspect: 0.9, cornerRadiusRatio: 0, rounded: false },
  { kind: 'diamond', label: 'Losango', hint: 'Um losango.', aspect: 1, cornerRadiusRatio: 0, rounded: false },
  { kind: 'arrow', label: 'Seta', hint: 'Aponta para a direita; gire para apontar para onde quiser.', aspect: 0.5, cornerRadiusRatio: 0, rounded: false },
  { kind: 'line', label: 'Linha', hint: 'Um traço; gire para inclinar, e os cantos fazem as pontas.', aspect: 0.06, cornerRadiusRatio: 0.5, rounded: true },
  { kind: 'star', label: 'Estrela', hint: 'Uma estrela de cinco pontas.', aspect: 1, cornerRadiusRatio: 0, rounded: false },
  { kind: 'heart', label: 'Coração', hint: 'Um coração.', aspect: 0.9, cornerRadiusRatio: 0, rounded: false }
]

export const shapeInfo = (kind: ShapeKind): ShapeInfo => SHAPES.find((shape) => shape.kind === kind) as ShapeInfo

/** Emojis offered first; any other can be typed. */
export const EMOJI_PICKS: readonly string[] = [
  '👍', '👎', '👏', '🙌', '👉', '👈', '👆', '👇',
  '🔥', '✅', '❌', '⚠️', '❗', '❓', '💡', '🎯',
  '🚀', '⭐', '🎉', '❤️', '💯', '✨', '🏆', '📌',
  '😀', '😂', '😮', '🤔', '😎', '👀', '💪', '🙏',
  '📣', '🔔', '💬', '🔍', '⏰', '💰', '📈', '📉'
]

/** The first emoji (grapheme) typed, or `null` when there is none. */
export function firstEmoji(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  const first = segmenter ? segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment : [...trimmed][0]
  return first ? first.slice(0, SHAPE_LIMITS.maxEmojiLength) : null
}

/** The stroke of a shape in output pixels, from its share of the output height. */
export const strokeWidthOf = (layer: ShapeLayer, outputHeight: number): number => (layer.strokeRatio > 0 ? Math.max(1, layer.strokeRatio * outputHeight) : 0)

/** Traces `shape` inside `box` on `path`, with the corners rounded by `cornerRadius` where that applies. */
export function traceShape(path: PathTarget, shape: ShapeKind, box: Rect, cornerRadius: number): void {
  const { x, y, width: w, height: h } = box
  const cx = x + w / 2
  const cy = y + h / 2
  switch (shape) {
    case 'rectangle':
    case 'line':
      path.roundRect(x, y, w, h, Math.min(cornerRadius, w / 2, h / 2))
      return
    case 'ellipse':
      path.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2)
      path.closePath()
      return
    case 'triangle':
      polygon(path, [
        [cx, y],
        [x + w, y + h],
        [x, y + h]
      ])
      return
    case 'diamond':
      polygon(path, [
        [cx, y],
        [x + w, cy],
        [cx, y + h],
        [x, cy]
      ])
      return
    case 'arrow': {
      // A shaft 40% as tall as the head, which takes the last 38% of the width.
      const headX = x + w * 0.62
      const shaft = h * 0.2
      polygon(path, [
        [x, cy - shaft],
        [headX, cy - shaft],
        [headX, y],
        [x + w, cy],
        [headX, y + h],
        [headX, cy + shaft],
        [x, cy + shaft]
      ])
      return
    }
    case 'star': {
      const points: Array<[number, number]> = []
      for (let index = 0; index < 10; index++) {
        const angle = -Math.PI / 2 + (index * Math.PI) / 5
        const reach = index % 2 === 0 ? 1 : 0.42
        points.push([cx + Math.cos(angle) * (w / 2) * reach, cy + Math.sin(angle) * (h / 2) * reach])
      }
      polygon(path, points)
      return
    }
    case 'heart':
      // Two lobes meeting at the top notch, down to the point.
      path.moveTo(cx, y + h * 0.3)
      path.bezierCurveTo(cx, y + h * 0.1, x + w * 0.3, y - h * 0.05, x + w * 0.05, y + h * 0.2)
      path.bezierCurveTo(x - w * 0.12, y + h * 0.45, x + w * 0.18, y + h * 0.72, cx, y + h)
      path.bezierCurveTo(x + w * 0.82, y + h * 0.72, x + w * 1.12, y + h * 0.45, x + w * 0.95, y + h * 0.2)
      path.bezierCurveTo(x + w * 0.7, y - h * 0.05, cx, y + h * 0.1, cx, y + h * 0.3)
      path.closePath()
      return
  }
}

function polygon(path: PathTarget, points: ReadonlyArray<readonly [number, number]>): void {
  points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
  path.closePath()
}

/** The `d` of an SVG path tracing `shape` inside `box`, for an icon of it. */
export function shapeSvgPath(shape: ShapeKind, box: Rect, cornerRadius: number): string {
  const parts: string[] = []
  const n = (value: number): string => String(Math.round(value * 100) / 100)
  traceShape(
    {
      moveTo: (x, y) => parts.push(`M${n(x)} ${n(y)}`),
      lineTo: (x, y) => parts.push(`L${n(x)} ${n(y)}`),
      bezierCurveTo: (a, b, c, d, x, y) => parts.push(`C${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(x)} ${n(y)}`),
      ellipse: (x, y, rx, ry) => parts.push(`M${n(x - rx)} ${n(y)}A${n(rx)} ${n(ry)} 0 1 0 ${n(x + rx)} ${n(y)}A${n(rx)} ${n(ry)} 0 1 0 ${n(x - rx)} ${n(y)}`),
      roundRect: (x, y, w, h, r) => {
        if (r <= 0) {
          parts.push(`M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`)
          return
        }
        parts.push(
          `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`
        )
      },
      closePath: () => parts.push('Z')
    },
    shape,
    box,
    cornerRadius
  )
  return parts.join('')
}

/** How a layer is named in lists: a file by its name, a shape by its kind, an emoji by itself. */
export function layerLabel(layer: Layer, fileName: (file: string) => string): string {
  switch (layer.kind) {
    case 'shape':
      return shapeInfo(layer.shape).label
    case 'emoji':
      return layer.emoji
    default:
      return fileName(layer.file)
  }
}

/** The proportions a layer is laid out with when it has no picture: a shape's own, an emoji's square. */
export function elementProportions(layer: ElementLayer): { width: number; height: number } {
  return layer.kind === 'shape' ? { width: 1, height: layer.aspect } : { width: 1, height: 1 }
}
