import type { TranscriptWord } from '@shared/models/captions'

/** How much of the transcript the library keeps at hand, for searching and for naming. */
export const PREVIEW_MAX_CHARS = 300
/** How many words a suggested name takes from the start of what was said. */
const TITLE_WORDS = 6
const TITLE_MAX_CHARS = 48

/** The start of what was said, as one line, for the library. */
export function transcriptPreview(words: readonly TranscriptWord[]): string {
  let text = ''
  for (const word of words) {
    const next = text === '' ? word.text : `${text} ${word.text}`
    if (next.length > PREVIEW_MAX_CHARS) break
    text = next
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A name for a recording that has none, from the first words said: the
 * first few, without the punctuation at the end, first letter capitalized.
 * `null` when nothing usable was said.
 */
export function suggestTitle(preview: string): string | null {
  const words = preview
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
  if (words.length < 2) return null
  let title = words.slice(0, TITLE_WORDS).join(' ')
  // A sentence that ends inside the first words ends the name too.
  const sentenceEnd = title.search(/[.!?…]/)
  if (sentenceEnd > 8) title = title.slice(0, sentenceEnd)
  title = title.replace(/[\s,;:.!?…"'“”‘’-]+$/u, '').trim()
  if (title.length > TITLE_MAX_CHARS) title = `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
  if (title.length < 3) return null
  return title.charAt(0).toLocaleUpperCase('pt-BR') + title.slice(1)
}
