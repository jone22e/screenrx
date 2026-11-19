import type { NormalizedPoint, SplitScreen, SplitShow } from '@shared/models/project'
import type { NormalizedRect, Rect, Size } from './frameLayout'

/** The two parts of a split frame and the line between them, in output pixels. */
export interface SplitLayout {
  main: Rect
  clip: Rect
  /** `null` when the line is off. */
  divider: Rect | null
}

/**
 * Splits the output along its height (`stacked`) or its width (`side`): the
 * recording takes `mainShare` of it, the clip the rest, the line sits over
 * the seam. Pixel edges are rounded so the two parts meet without a gap.
 */
export function layoutSplit(output: Size, split: SplitScreen): SplitLayout {
  // Only the clip: it has the whole frame, the recording none.
  if (split.show === 'clip') return { clip: { x: 0, y: 0, width: output.width, height: output.height }, main: { x: 0, y: 0, width: 0, height: 0 }, divider: null }
  const stacked = split.orientation === 'stacked'
  const length = stacked ? output.height : output.width
  const mainLength = Math.round(length * split.mainShare)
  const firstLength = split.clipFirst ? length - mainLength : mainLength
  const part = (start: number, size: number): Rect =>
    stacked ? { x: 0, y: start, width: output.width, height: size } : { x: start, y: 0, width: size, height: output.height }
  const first = part(0, firstLength)
  const second = part(firstLength, length - firstLength)
  const thickness = Math.round(split.dividerRatio * Math.min(output.width, output.height))
  const divider =
    thickness > 0
      ? stacked
        ? { x: 0, y: firstLength - thickness / 2, width: output.width, height: thickness }
        : { x: firstLength - thickness / 2, y: 0, width: thickness, height: output.height }
      : null
  return split.clipFirst ? { clip: first, main: second, divider } : { main: first, clip: second, divider }
}

/**
 * The largest region of a picture with the box's shape, centred as near
 * `focus` as the picture allows: what fills the box without squeezing.
 */
export function coverCrop(box: Size, picture: Size, focus: NormalizedPoint): NormalizedRect {
  if (box.width <= 0 || box.height <= 0 || picture.width <= 0 || picture.height <= 0) return { x: 0, y: 0, width: 1, height: 1 }
  const boxRatio = box.width / box.height
  const pictureRatio = picture.width / picture.height
  const width = pictureRatio > boxRatio ? boxRatio / pictureRatio : 1
  const height = pictureRatio > boxRatio ? 1 : pictureRatio / boxRatio
  return {
    x: clamp(focus.x - width / 2, 0, 1 - width),
    y: clamp(focus.y - height / 2, 0, 1 - height),
    width,
    height
  }
}

/** The split in effect at an instant: the first video layer with one whose span holds it. */
export function splitAt<Layer extends { kind: string; startMs: number; endMs: number; split?: SplitScreen }>(layers: readonly Layer[], sourceMs: number): Layer | null {
  return layers.find((layer) => layer.kind === 'video' && layer.split !== undefined && sourceMs >= layer.startMs && sourceMs < layer.endMs) ?? null
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

interface SecondVideoPiece {
  id: string
  kind: 'video'
  file: string
  startMs: number
  endMs: number
  offsetMs: number
  split?: SplitScreen
}

/**
 * Shows `show` from `startMs` to `endMs` on the second video: the clip's
 * layers there are cut at the stretch's edges (each piece keeps the clip in
 * step: its offset moves with its start) and the pieces inside get the new
 * setting, split on with `fallback` where it was not. Neighbouring pieces
 * left the same are joined again. Times outside the clip's layers are left
 * alone: there is no video 2 there to show.
 */
export function applyLayoutSpan<Layer extends { id: string; kind: string; startMs: number; endMs: number }>(
  layers: readonly Layer[],
  file: string,
  span: { startMs: number; endMs: number },
  show: SplitShow,
  fallback: SplitScreen,
  newId: () => string
): Layer[] {
  const result: Layer[] = []
  for (const layer of layers) {
    const piece = layer as unknown as SecondVideoPiece
    if (piece.kind !== 'video' || piece.file !== file || span.endMs <= piece.startMs || span.startMs >= piece.endMs) {
      result.push(layer)
      continue
    }
    const cuts = [piece.startMs, Math.max(piece.startMs, span.startMs), Math.min(piece.endMs, span.endMs), piece.endMs]
    let first = true
    for (let index = 0; index < 3; index++) {
      const startMs = cuts[index] as number
      const endMs = cuts[index + 1] as number
      if (endMs - startMs < 1) continue
      const inside = index === 1
      const base = piece.split ?? fallback
      const split: SplitScreen = inside ? withShow(base, show) : base
      const next = {
        ...piece,
        id: first ? piece.id : newId(),
        startMs,
        endMs,
        offsetMs: piece.offsetMs + (startMs - piece.startMs),
        ...(inside || piece.split ? { split } : {})
      }
      if (!inside && !piece.split) delete (next as SecondVideoPiece).split
      first = false
      result.push(next as unknown as Layer)
    }
  }
  return joinPieces(result, file)
}

const withShow = (split: SplitScreen, show: SplitShow): SplitScreen => {
  const next = { ...split }
  if (show === 'both') delete next.show
  else next.show = show
  return next
}

/** Pieces of the same clip that touch, in step, with the same setting, become one again. */
function joinPieces<Layer extends { id: string; kind: string; startMs: number; endMs: number }>(layers: Layer[], file: string): Layer[] {
  const result: Layer[] = []
  for (const layer of layers) {
    const piece = layer as unknown as SecondVideoPiece
    const previousIndex = result.findIndex((candidate) => {
      const other = candidate as unknown as SecondVideoPiece
      return other.kind === 'video' && other.file === file && Math.abs(other.endMs - piece.startMs) < 1 && Math.abs(other.offsetMs + (other.endMs - other.startMs) - piece.offsetMs) < 1
    })
    const previous = previousIndex >= 0 ? (result[previousIndex] as unknown as SecondVideoPiece) : null
    if (piece.kind === 'video' && piece.file === file && previous && JSON.stringify(previous.split ?? null) === JSON.stringify(piece.split ?? null)) {
      result[previousIndex] = { ...(result[previousIndex] as Layer), endMs: piece.endMs }
      continue
    }
    result.push(layer)
  }
  return result
}
