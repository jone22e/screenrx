import type { TrimEffect } from '@shared/models/project'

/** Tunables of the transitions at the cuts. */
export const TRANSITION_CONFIG = {
  /** How long a dip takes in all: half before the cut (going dark), half after it (coming back). */
  dipMs: 400
} as const

/**
 * How dark the picture is at `sourceMs` because of the dips at the cuts:
 * 0 clear, 1 black. A cut with a dip darkens the last moments before it and
 * brightens the first moments after it. `trims` must be sorted and never
 * overlap. Works in source time, so the preview (which jumps the cut) and
 * the export (which maps every frame to its source instant) agree.
 */
export function dipDarknessAt(trims: readonly TrimEffect[], sourceMs: number): number {
  const half = TRANSITION_CONFIG.dipMs / 2
  let darkness = 0
  for (const trim of trims) {
    if (trim.transition !== 'dip') continue
    const before = trim.startMs - sourceMs
    if (before > 0 && before <= half) darkness = Math.max(darkness, 1 - before / half)
    const after = sourceMs - trim.endMs
    if (after >= 0 && after < half) darkness = Math.max(darkness, 1 - after / half)
    if (sourceMs >= trim.startMs && sourceMs < trim.endMs) darkness = 1
  }
  return darkness
}
