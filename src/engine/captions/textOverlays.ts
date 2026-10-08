import type { TextOverlay } from '@shared/models/project'

/** The texts on screen at `timeMs`, in the order they are drawn (the later one on top). */
export function textsAt(texts: readonly TextOverlay[], timeMs: number): TextOverlay[] {
  return texts.filter((text) => timeMs >= text.startMs && timeMs < text.endMs && text.text.trim() !== '')
}
