import type { ZoomEffect } from '@shared/models/project'
import { ZOOM_ANIMATION } from './zoomConfig'

/**
 * What the virtual camera shows at an instant: `scale` 1 is the whole frame,
 * and `center` is the normalized point at the middle of the view.
 */
export interface Camera {
  scale: number
  centerX: number
  centerY: number
}

/** A region of the source frame, in normalized coordinates. */
export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export const IDENTITY_CAMERA: Camera = { scale: 1, centerX: 0.5, centerY: 0.5 }

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/** Smooth start and stop (cubic), so a zoom never snaps. */
export function easeInOut(progress: number): number {
  const t = clamp(progress, 0, 1)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** The camera of a zoom once fully arrived, kept inside the frame. */
function settledCamera(zoom: ZoomEffect): Camera {
  return constrain({ scale: zoom.scale, centerX: zoom.focus.x, centerY: zoom.focus.y })
}

/** Keeps the view inside the frame: near an edge, the focus cannot be centred. */
function constrain(camera: Camera): Camera {
  const scale = Math.max(camera.scale, 1)
  const half = 0.5 / scale
  return {
    scale,
    centerX: clamp(camera.centerX, half, 1 - half),
    centerY: clamp(camera.centerY, half, 1 - half)
  }
}

function mix(from: Camera, to: Camera, progress: number): Camera {
  return constrain({
    scale: from.scale + (to.scale - from.scale) * progress,
    centerX: from.centerX + (to.centerX - from.centerX) * progress,
    centerY: from.centerY + (to.centerY - from.centerY) * progress
  })
}

/**
 * The camera at `timeMs` for a list of zooms sorted by start time and not
 * overlapping. This is the single source of zoom motion: the preview and
 * the export both call it, so what is seen is what is exported.
 *
 * Each zoom eases in over its first moments and out over its last. When two
 * zooms are back to back, the camera travels straight from one to the other
 * instead of zooming all the way out in between.
 */
export function cameraAt(zooms: readonly ZoomEffect[], timeMs: number): Camera {
  const index = zooms.findIndex((zoom) => timeMs >= zoom.startMs && timeMs < zoom.endMs)
  const zoom = zooms[index]
  if (!zoom) return IDENTITY_CAMERA

  const previous = zooms[index - 1]
  const next = zooms[index + 1]
  const gap = ZOOM_ANIMATION.contiguousGapMs
  const arrivesFrom = previous && zoom.startMs - previous.endMs <= gap ? previous : null
  const leavesTo = next && next.startMs - zoom.endMs <= gap ? next : null

  // A short zoom splits its span between arriving and leaving.
  const length = zoom.endMs - zoom.startMs
  const inDuration = Math.min(ZOOM_ANIMATION.zoomInDurationMs, length / 2)
  const outDuration = Math.min(ZOOM_ANIMATION.zoomOutDurationMs, length / 2)

  const target = settledCamera(zoom)
  const origin = arrivesFrom ? settledCamera(arrivesFrom) : IDENTITY_CAMERA
  const arrived = mix(origin, target, easeInOut((timeMs - zoom.startMs) / inDuration))
  if (leavesTo) return arrived

  const remaining = easeInOut((zoom.endMs - timeMs) / outDuration)
  return mix(IDENTITY_CAMERA, arrived, remaining)
}

/** The part of the source frame the camera shows. */
export function visibleRect(camera: Camera): NormalizedRect {
  const size = 1 / camera.scale
  return { x: camera.centerX - size / 2, y: camera.centerY - size / 2, width: size, height: size }
}

/** Maps a point of the rendered view (0…1) back to the source frame. */
export function viewToSource(camera: Camera, viewX: number, viewY: number): { x: number; y: number } {
  const rect = visibleRect(camera)
  return { x: rect.x + viewX * rect.width, y: rect.y + viewY * rect.height }
}
