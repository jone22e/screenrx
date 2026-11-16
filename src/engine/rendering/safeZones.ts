import type { FrameAspect } from '@shared/models/project'
import { CAPTION_POSITIONS } from '../captions/captionConfig'

/** A part of the output the social apps cover with their own interface, as shares of the output. */
export interface SafeZoneBand {
  x: number
  y: number
  width: number
  height: number
  label: string
}

/**
 * Where the apps' interface sits over a 9:16 video: the status bar and
 * title at the top, the caption and music at the bottom, the column of
 * buttons on the right. Each is named, so the marks explain themselves on
 * the preview. Other shapes play in the feed, uncovered.
 */
const VERTICAL_BANDS: readonly SafeZoneBand[] = [
  { x: 0, y: 0, width: 1, height: 0.1, label: 'Topo do app' },
  { x: 0, y: 0.8, width: 1, height: 0.2, label: 'Legenda e música do app' },
  { x: 0.84, y: 0.35, width: 0.16, height: 0.45, label: 'Botões' }
]

export function safeZones(aspect: FrameAspect): readonly SafeZoneBand[] {
  return aspect === '9:16' ? VERTICAL_BANDS : []
}

export type CaptionPlacement = keyof typeof CAPTION_POSITIONS

/**
 * Where a caption's centre goes for a one-click placement, kept out of the
 * covered bands: on a vertical video "bottom" sits above the app's own
 * caption and "top" below its title; elsewhere, the usual places.
 */
export function captionPlacementY(placement: CaptionPlacement, aspect: FrameAspect): number {
  if (aspect === '9:16') {
    if (placement === 'bottom') return 0.72
    if (placement === 'top') return 0.17
  }
  return CAPTION_POSITIONS[placement]
}

/** Which one-click placement a caption centre is at, if any, for `aspect`. */
export function captionPlacementOf(position: { x: number; y: number }, aspect: FrameAspect): CaptionPlacement | null {
  if (Math.abs(position.x - 0.5) > 1e-6) return null
  for (const placement of ['top', 'middle', 'bottom'] as const) {
    if (Math.abs(position.y - captionPlacementY(placement, aspect)) < 1e-6) return placement
  }
  return null
}
