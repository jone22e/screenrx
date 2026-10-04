export interface ByteRange {
  start: number
  /** Inclusive. */
  end: number
}

/**
 * Parses a single-range HTTP `Range` header (`bytes=0-499`, `bytes=500-`,
 * `bytes=-500`) against a resource of `size` bytes. Returns `null` when the
 * header is absent, malformed or unsatisfiable.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || size <= 0) return null
  const [, first, last] = match
  if (first === '' && last === '') return null

  if (first === '') {
    const suffix = Number(last)
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  return start <= end && start < size ? { start, end } : null
}
