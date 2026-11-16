import type { CaptionAnimation } from '@shared/models/project'
import { easeInOut } from '../zoom/zoomCamera'
import { CAPTION_ANIMATION } from './captionConfig'

/** How a caption is transformed as a whole at an instant: drawn `scale` times its size, at `alpha`. */
export interface CaptionEntrance {
  scale: number
  alpha: number
}

const STILL: CaptionEntrance = { scale: 1, alpha: 1 }

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)

/**
 * The caption's entrance, `sinceStartMs` after it came on screen. `pop`
 * swells a little past its size and settles; `fade` comes in from nothing.
 */
export function captionEntrance(animation: CaptionAnimation, sinceStartMs: number): CaptionEntrance {
  switch (animation) {
    case 'pop': {
      const progress = clamp01(sinceStartMs / CAPTION_ANIMATION.popMs)
      if (progress >= 1) return STILL
      // Up to the overshoot in the first half, back to size in the second.
      const swing = progress < 0.5 ? easeInOut(progress * 2) : 1 - easeInOut((progress - 0.5) * 2)
      return { scale: 1 + (CAPTION_ANIMATION.popOvershoot - 1) * swing, alpha: 1 }
    }
    case 'fade': {
      const progress = clamp01(sinceStartMs / CAPTION_ANIMATION.fadeMs)
      return progress >= 1 ? STILL : { scale: 1, alpha: easeInOut(progress) }
    }
    default:
      return STILL
  }
}

/**
 * How much bigger the spoken word is drawn in the `highlight` mode,
 * `sinceWordMs` after it began. With `pop` it grows into its size; otherwise
 * it is already there.
 */
export function activeWordScale(animation: CaptionAnimation, sinceWordMs: number): number {
  if (animation !== 'pop') return CAPTION_ANIMATION.wordScale
  const progress = clamp01(sinceWordMs / CAPTION_ANIMATION.wordPopMs)
  return 1 + (CAPTION_ANIMATION.wordScale - 1) * easeInOut(progress)
}
