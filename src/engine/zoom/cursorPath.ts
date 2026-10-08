import type { NormalizedPoint } from '@shared/models/project'
import type { CursorSample } from '@shared/models/telemetry'

/** Tunables of following the pointer with the part of the recording in use. */
export const CURSOR_FOLLOW = {
  /** The pointer's positions over this much time are averaged: the frame glides instead of twitching. */
  windowMs: 600,
  /** How far apart the smoothed path's points are. */
  stepMs: 50
} as const

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)

/** The sample in force at `timeMs`: the last one at or before it (positions hold until the next). */
function sampleAt(samples: readonly CursorSample[], timeMs: number): CursorSample | null {
  let low = 0
  let high = samples.length - 1
  let found: CursorSample | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    const sample = samples[middle] as CursorSample
    if (sample.timeMs <= timeMs) {
      found = sample
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * The pointer's path, smoothed: one point every `stepMs`, each the average
 * of where the pointer was over the `windowMs` before it, kept inside the
 * recording. Computed once per recording; the preview and the export read
 * the same path, so the frame moves the same way in both.
 */
export function smoothCursorPath(samples: readonly CursorSample[], durationMs: number): NormalizedPoint[] {
  if (samples.length === 0) return []
  const { windowMs, stepMs } = CURSOR_FOLLOW
  const taps = Math.max(1, Math.round(windowMs / stepMs))
  const path: NormalizedPoint[] = []
  for (let timeMs = 0; timeMs <= durationMs; timeMs += stepMs) {
    let x = 0
    let y = 0
    let count = 0
    for (let tap = 0; tap < taps; tap++) {
      const sample = sampleAt(samples, timeMs - tap * stepMs)
      if (!sample) continue
      x += clamp01(sample.x)
      y += clamp01(sample.y)
      count += 1
    }
    const previous = path[path.length - 1]
    const first = samples[0] as CursorSample
    path.push(count > 0 ? { x: x / count, y: y / count } : (previous ?? { x: clamp01(first.x), y: clamp01(first.y) }))
  }
  return path
}

/** Where the smoothed path puts the pointer at `timeMs`; the centre when there is no path. */
export function pointerAt(path: readonly NormalizedPoint[], timeMs: number): NormalizedPoint {
  if (path.length === 0) return { x: 0.5, y: 0.5 }
  const index = Math.min(path.length - 1, Math.max(0, Math.round(timeMs / CURSOR_FOLLOW.stepMs)))
  return path[index] as NormalizedPoint
}
