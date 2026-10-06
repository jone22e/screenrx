import type { CaptionLanguage } from '@shared/models/project'

/** The recognizer language each dubbing language is checked in. */
export const VERIFICATION_LOCALES: Record<CaptionLanguage, string> = {
  en: 'en-US',
  es: 'es-ES',
  zh: 'zh-CN',
  pt: 'pt-BR'
}

/** What is compared: letters and digits only, in lower case, without accents. */
function comparable(text: string): string[] {
  return [
    ...text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '')
  ]
}

/** Length of the longest common subsequence of two sequences. */
function commonLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0)
  for (const left of a) {
    const current = [0]
    for (let index = 0; index < b.length; index++) {
      current.push(left === b[index] ? (previous[index] ?? 0) + 1 : Math.max(previous[index + 1] ?? 0, current[index] ?? 0))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/**
 * How much of what should have been said a recognizer heard, from 0 to 1:
 * the share of the expected characters found, in order, in what was heard.
 * Punctuation, case, spacing and accents do not count. A score is not a
 * verdict on quality — a recognizer mistakes homophones — but speech it
 * hears nothing of, or half of, is speech a listener will not follow either.
 */
export function speechSimilarity(expected: string, heard: string): number {
  const wanted = comparable(expected)
  if (wanted.length === 0) return 1
  return commonLength(wanted, comparable(heard)) / wanted.length
}
