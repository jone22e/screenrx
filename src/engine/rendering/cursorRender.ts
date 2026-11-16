import type { CursorSmoothing, NormalizedPoint } from '@shared/models/project'
import type { CursorSample, InteractionEvent } from '@shared/models/telemetry'

/** Tunables of drawing the pointer from its telemetry, in place of the one the system burned into older recordings. */
export const CURSOR_DRAW = {
  /** How far apart the drawn path's points are: finer than any frame rate the export offers. */
  stepMs: 16,
  /** Over how long the pointer's positions are averaged, per smoothing setting. */
  smoothingMs: { none: 0, light: 100, strong: 260 } satisfies Record<CursorSmoothing, number>,
  /** How long the ring of a click takes to spread out and fade. */
  rippleMs: 450,
  /** The ring's reach at its widest, as a ratio of the cursor's height. */
  rippleReach: 2.2
} as const

/**
 * The outline of the arrow, in a box one unit tall (the cursor's height) and
 * about 0.6 wide, tip at the origin: the shape everyone knows from the Mac.
 */
export const ARROW_OUTLINE: ReadonlyArray<NormalizedPoint> = [
  { x: 0, y: 0 },
  { x: 0, y: 0.82 },
  { x: 0.2, y: 0.64 },
  { x: 0.34, y: 0.96 },
  { x: 0.47, y: 0.9 },
  { x: 0.33, y: 0.59 },
  { x: 0.6, y: 0.59 }
]

const CLICK_TYPES: ReadonlySet<InteractionEvent['type']> = new Set(['click', 'doubleClick', 'rightClick', 'middleClick'])

/** The pointer at `timeMs`, between the samples around it; `null` before the first. */
function interpolatedAt(samples: readonly CursorSample[], timeMs: number): NormalizedPoint | null {
  if (samples.length === 0) return null
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((samples[middle] as CursorSample).timeMs <= timeMs) low = middle
    else high = middle - 1
  }
  const before = samples[low] as CursorSample
  if (before.timeMs > timeMs) return null
  const after = samples[low + 1]
  if (!after || after.timeMs <= before.timeMs) return { x: before.x, y: before.y }
  const share = Math.min(1, (timeMs - before.timeMs) / (after.timeMs - before.timeMs))
  return { x: before.x + (after.x - before.x) * share, y: before.y + (after.y - before.y) * share }
}

/**
 * The pointer's path as drawn: one point every `stepMs`, interpolated
 * between the recorded samples, and averaged over the smoothing window so
 * a shaky hand reads as a steady one. Positions are not clamped: outside
 * 0…1 the pointer has left the recording and is not drawn.
 */
export function drawnCursorPath(samples: readonly CursorSample[], durationMs: number, smoothing: CursorSmoothing): Array<NormalizedPoint | null> {
  if (samples.length === 0) return []
  const windowMs = CURSOR_DRAW.smoothingMs[smoothing]
  const tapMs = 8
  const taps = windowMs > 0 ? Math.max(1, Math.round(windowMs / tapMs)) : 1
  const path: Array<NormalizedPoint | null> = []
  for (let timeMs = 0; timeMs <= durationMs; timeMs += CURSOR_DRAW.stepMs) {
    let x = 0
    let y = 0
    let count = 0
    for (let tap = 0; tap < taps; tap++) {
      const point = interpolatedAt(samples, timeMs - tap * tapMs)
      if (!point) continue
      x += point.x
      y += point.y
      count += 1
    }
    path.push(count > 0 ? { x: x / count, y: y / count } : null)
  }
  return path
}

/** Where the drawn path puts the pointer at `timeMs`; `null` when it is not known or has left the recording. */
export function drawnCursorAt(path: ReadonlyArray<NormalizedPoint | null>, timeMs: number): NormalizedPoint | null {
  if (path.length === 0) return null
  const index = Math.min(path.length - 1, Math.max(0, Math.round(timeMs / CURSOR_DRAW.stepMs)))
  const point = path[index] ?? null
  return point && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null
}

/** A click whose ring is still spreading at an instant: where, and how far along (0 just clicked, 1 gone). */
export interface ClickRipple {
  x: number
  y: number
  progress: number
}

/** The clicks still rippling at `timeMs`. `interactions` must be in time order. */
export function clickRipplesAt(interactions: readonly InteractionEvent[], timeMs: number): ClickRipple[] {
  const ripples: ClickRipple[] = []
  for (const event of interactions) {
    if (event.timeMs > timeMs) break
    const ageMs = timeMs - event.timeMs
    if (ageMs >= CURSOR_DRAW.rippleMs || !CLICK_TYPES.has(event.type)) continue
    ripples.push({ x: event.x, y: event.y, progress: ageMs / CURSOR_DRAW.rippleMs })
  }
  return ripples
}
