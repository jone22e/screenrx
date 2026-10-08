import type { BackgroundSettings, FrameAspect, NormalizedPoint, WebcamCorner, WebcamSettings } from '@shared/models/project'

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where the recording sits on the output, in output pixels. */
export interface FrameLayout {
  frame: Rect
  cornerRadius: number
}

/** Tunables of the webcam picture. */
export const WEBCAM_LAYOUT = {
  /** Distance from the edges when snapped to a corner, as a ratio of the output height. */
  marginRatio: 0.04,
  /** Corner radius of the `rounded` shape, as a ratio of the picture's side. */
  roundedRadiusRatio: 0.2
} as const

/** Where the webcam picture sits on the output, in output pixels. */
export interface WebcamLayout extends Rect {
  cornerRadius: number
}

/** Width ÷ height of each format; `null` keeps the recording's own. */
const ASPECT_RATIOS: Record<FrameAspect, number | null> = {
  native: null,
  reels: 9 / 16,
  tiktok: 9 / 16
}

/**
 * The size of the output for a recording in a format: the recording's own
 * size, or a box of the format's shape whose shorter side is the recording's
 * shorter side (a 1920×1080 recording gives a 1080×1920 vertical video).
 */
export function outputSizeFor(source: Size, aspect: FrameAspect): Size {
  const ratio = ASPECT_RATIOS[aspect]
  if (ratio === null) return { width: source.width, height: source.height }
  const shorter = Math.min(source.width, source.height)
  return ratio >= 1
    ? { width: Math.round(shorter * ratio), height: shorter }
    : { width: shorter, height: Math.round(shorter / ratio) }
}

/** Whether the recording is enlarged to fill a frame of another shape, showing only a part of it. */
const fills = (background: BackgroundSettings): boolean => background.aspect !== 'native' && background.fit === 'fill'

/**
 * Places the recording on the output: as large as fits, keeping its aspect
 * ratio, centred — or, when it fills, the whole room, a part of the
 * recording being shown (`sourceCrop`). With a backdrop it is inset by the
 * padding on every side and gets rounded corners; without one it goes edge
 * to edge, which fills the output when the two have the same shape.
 */
export function layoutFrame(output: Size, source: Size, background: BackgroundSettings, framed: boolean): FrameLayout {
  const padding = framed ? background.paddingRatio : 0
  const room = { width: output.width * (1 - 2 * padding), height: output.height * (1 - 2 * padding) }
  const scale = fills(background)
    ? Math.max(room.width / source.width, room.height / source.height)
    : Math.min(room.width / source.width, room.height / source.height)
  const width = fills(background) ? room.width : source.width * scale
  const height = fills(background) ? room.height : source.height * scale
  return {
    frame: { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height },
    cornerRadius: framed ? background.cornerRadiusRatio * Math.min(output.width, output.height) : 0
  }
}

/** A region of the recording, normalized to it. */
export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The part of the recording shown: all of it, or, when it fills a frame of
 * another shape, the largest region of the frame's shape, centred on
 * `background.crop` and kept inside the recording.
 */
export function sourceCrop(output: Size, source: Size, background: BackgroundSettings): NormalizedRect {
  if (!fills(background)) return { x: 0, y: 0, width: 1, height: 1 }
  const sourceRatio = source.width / source.height
  const frameRatio = output.width / output.height
  const width = sourceRatio > frameRatio ? frameRatio / sourceRatio : 1
  const height = sourceRatio > frameRatio ? 1 : sourceRatio / frameRatio
  return {
    x: clamp(background.crop.x - width / 2, 0, 1 - width),
    y: clamp(background.crop.y - height / 2, 0, 1 - height),
    width,
    height
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/** Centre of the webcam picture when snapped to `corner`, normalized to the output. */
export function webcamCornerPosition(output: Size, sizeRatio: number, corner: WebcamCorner): NormalizedPoint {
  const side = sizeRatio * output.height
  const inset = WEBCAM_LAYOUT.marginRatio * output.height + side / 2
  return {
    x: (corner.endsWith('left') ? inset : output.width - inset) / output.width,
    y: (corner.startsWith('top') ? inset : output.height - inset) / output.height
  }
}

/**
 * The webcam picture: a square of `sizeRatio` × output height, at a corner
 * or wherever the user dragged it, always fully inside the output. Its
 * shape only changes how much the corners are rounded.
 */
export function layoutWebcam(output: Size, settings: WebcamSettings): WebcamLayout {
  const side = Math.min(settings.sizeRatio * output.height, output.width, output.height)
  const centre = settings.corner
    ? webcamCornerPosition(output, settings.sizeRatio, settings.corner)
    : settings.position
  const x = clamp(centre.x * output.width - side / 2, 0, output.width - side)
  const y = clamp(centre.y * output.height - side / 2, 0, output.height - side)
  const cornerRadius =
    settings.shape === 'circle'
      ? side / 2
      : settings.shape === 'rounded'
        ? side * WEBCAM_LAYOUT.roundedRadiusRatio
        : 0
  return { x, y, width: side, height: side, cornerRadius }
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/** The largest centred square of a source, for cropping the webcam into its circle. */
export function centeredSquare(source: Size): Rect {
  const side = Math.min(source.width, source.height)
  return { x: (source.width - side) / 2, y: (source.height - side) / 2, width: side, height: side }
}
