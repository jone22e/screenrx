import type { TextMotion, TextMotionKind } from '@shared/models/project'
import { easeInOut } from '../zoom/zoomCamera'

/** How a text is transformed at an instant: drawn `scale` times its size, at `alpha`, shifted down by `offsetY` of the output height. */
export interface TextTransform {
  scale: number
  alpha: number
  offsetY: number
}

export const STILL_TRANSFORM: TextTransform = { scale: 1, alpha: 1, offsetY: 0 }

/** Tunables of the texts' entrances and exits. */
export const TEXT_MOTION = {
  /** How far a sliding text travels, as a ratio of the output height. */
  slideRatio: 0.04,
  /** How far past its size a popping text swings. */
  popOvershoot: 1.1
} as const

export const TEXT_MOTION_LABELS: Record<TextMotionKind, string> = {
  none: 'Nenhuma',
  fade: 'Fade',
  pop: 'Pop',
  'slide-up': 'Subir'
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)

/** The transform `progress` (0 just started, 1 settled) of the way into an entrance of `kind`. */
function entering(kind: TextMotionKind, progress: number): TextTransform {
  const eased = easeInOut(progress)
  switch (kind) {
    case 'fade':
      return { scale: 1, alpha: eased, offsetY: 0 }
    case 'pop': {
      // Up to the overshoot in the first half, back to size in the second; visible from the start.
      const swing = progress < 0.5 ? easeInOut(progress * 2) : 1 - easeInOut((progress - 0.5) * 2)
      return { scale: progress === 0 ? 0.6 : 1 + (TEXT_MOTION.popOvershoot - 1) * swing, alpha: clamp01(progress * 4), offsetY: 0 }
    }
    case 'slide-up':
      return { scale: 1, alpha: eased, offsetY: TEXT_MOTION.slideRatio * (1 - eased) }
    default:
      return STILL_TRANSFORM
  }
}

/**
 * The transform of a text at an instant: its entrance over the first
 * `enter.durationMs` on screen, its exit over the last `exit.durationMs`,
 * still in between. An exit is the entrance played backwards, so a text that
 * slid up slides on upwards and out.
 */
export function textTransformAt(enter: TextMotion, exit: TextMotion, sinceStartMs: number, untilEndMs: number): TextTransform {
  if (enter.kind !== 'none' && enter.durationMs > 0 && sinceStartMs < enter.durationMs) {
    return entering(enter.kind, clamp01(sinceStartMs / enter.durationMs))
  }
  if (exit.kind !== 'none' && exit.durationMs > 0 && untilEndMs < exit.durationMs) {
    const leaving = entering(exit.kind, clamp01(untilEndMs / exit.durationMs))
    return exit.kind === 'slide-up' ? { ...leaving, offsetY: -leaving.offsetY } : leaving
  }
  return STILL_TRANSFORM
}
