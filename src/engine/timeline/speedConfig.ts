import type { SpeedEffect } from '@shared/models/project'

/** Tunables of speed regions: stretches of the recording played faster or slower than the rest. */
export const SPEED_CONFIG = {
  /** The factors offered, slowest to fastest; 1 is not one, that is "no region". */
  factors: [0.5, 0.75, 1.25, 1.5, 2, 3, 4] as readonly number[],
  defaultFactor: 2,
  /** Length of a region created at the playhead, before the user adjusts it. */
  defaultDurationMs: 3000,
  minDurationMs: 200
} as const

export function isSpeedFactor(value: unknown): value is number {
  return typeof value === 'number' && SPEED_CONFIG.factors.includes(value)
}

/** The factor the recording plays at in source instant `timeMs`: a region's, or 1 outside any. `speeds` must be sorted. */
export function speedAt(speeds: readonly SpeedEffect[], timeMs: number): number {
  for (const region of speeds) {
    if (timeMs < region.startMs) break
    if (timeMs < region.endMs) return region.speed
  }
  return 1
}
