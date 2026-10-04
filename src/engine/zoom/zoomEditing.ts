import type { ZoomEffect } from '@shared/models/project'
import type { TimeSpan } from '../timeline/spanEditing'
import { moveSpan, resizeSpan, spanForNew } from '../timeline/spanEditing'
import { MANUAL_ZOOM_DEFAULTS, ZOOM_LIMITS } from './zoomConfig'

export type { TimeSpan }

/** Timeline edits of zoom regions; see `spanEditing` for the shared rules. */

export function moveZoom(
  zooms: readonly ZoomEffect[],
  original: ZoomEffect,
  deltaMs: number,
  durationMs: number
): TimeSpan {
  return moveSpan(zooms, original, deltaMs, durationMs)
}

export function resizeZoom(
  zooms: readonly ZoomEffect[],
  original: ZoomEffect,
  edge: 'start' | 'end',
  timeMs: number,
  durationMs: number
): TimeSpan {
  return resizeSpan(zooms, original, edge, timeMs, durationMs, ZOOM_LIMITS.minDurationMs)
}

export function spanForNewZoom(
  zooms: readonly ZoomEffect[],
  timeMs: number,
  durationMs: number
): TimeSpan | null {
  return spanForNew(zooms, timeMs, durationMs, MANUAL_ZOOM_DEFAULTS.durationMs, ZOOM_LIMITS.minDurationMs)
}

export function clampScale(scale: number): number {
  return Math.min(Math.max(scale, ZOOM_LIMITS.minScale), ZOOM_LIMITS.maxScale)
}
