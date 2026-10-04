/** Every tunable of zoom generation, animation and editing, in one place. */

export const AUTO_ZOOM_CONFIG = {
  /** Clicks closer together in time than this belong to the same zoom. */
  clickClusterMergeGapMs: 2500,
  /**
   * …unless they are this far apart on screen (normalized distance): a click
   * on the other side of the frame starts a new zoom with its own focus.
   */
  clickClusterMaxDistance: 0.3,
  /** Lead-in before the first click, so the zoom has arrived when it happens. */
  paddingBeforeMs: 500,
  /** Hold after the last click, so its result can be seen before zooming out. */
  paddingAfterMs: 1000,
  scale: 1.6
} as const

/** Shared by preview and export, so both animate identically. */
export const ZOOM_ANIMATION = {
  zoomInDurationMs: 450,
  zoomOutDurationMs: 450,
  /** Zooms closer than this are treated as back-to-back: the camera pans instead of zooming out and in. */
  contiguousGapMs: 1
} as const

export const ZOOM_LIMITS = {
  minScale: 1.1,
  maxScale: 4,
  /** Shorter than this, a zoom is all transition. */
  minDurationMs: 600
} as const

export const MANUAL_ZOOM_DEFAULTS = {
  durationMs: 3000,
  scale: 1.6
} as const
