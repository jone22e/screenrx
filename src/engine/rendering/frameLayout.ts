import type { BackgroundSettings, NormalizedPoint, WebcamCorner, WebcamSettings } from '@shared/models/project'

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

/**
 * Places the recording on the output. With a backdrop it is inset by the
 * padding on every side — scaled uniformly, so its aspect ratio is kept —
 * and gets rounded corners; without one it fills the output edge to edge.
 */
export function layoutFrame(output: Size, background: BackgroundSettings, framed: boolean): FrameLayout {
  if (!framed) {
    return { frame: { x: 0, y: 0, width: output.width, height: output.height }, cornerRadius: 0 }
  }
  const scale = 1 - 2 * background.paddingRatio
  const width = output.width * scale
  const height = output.height * scale
  return {
    frame: { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height },
    cornerRadius: background.cornerRadiusRatio * Math.min(output.width, output.height)
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
