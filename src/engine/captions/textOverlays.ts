import type { TextOverlay } from '@shared/models/project'
import type { TextTransform } from '../rendering/animation'
import { textTransformAt } from '../rendering/animation'

/** The texts on screen at `timeMs`, in the order they are drawn (the later one on top). */
export function textsAt(texts: readonly TextOverlay[], timeMs: number): TextOverlay[] {
  return texts.filter((text) => timeMs >= text.startMs && timeMs < text.endMs && text.text.trim() !== '')
}

/** The texts on screen at `timeMs`, each with how it is transformed by its entrance or exit then. */
export function textsWithMotionAt(texts: readonly TextOverlay[], timeMs: number): Array<TextOverlay & { motion: TextTransform }> {
  return textsAt(texts, timeMs).map((text) => ({
    ...text,
    motion: textTransformAt(text.enter, text.exit, timeMs - text.startMs, text.endMs - timeMs)
  }))
}
