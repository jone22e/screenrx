import path from 'node:path'

export class PathEscapeError extends Error {
  constructor(target: string) {
    super(`Path escapes its root directory: ${target}`)
    this.name = 'PathEscapeError'
  }
}

/** A single path component: no separators, no traversal, nothing exotic. */
export function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0]/.test(name)
  )
}

/**
 * Resolves `segments` under `root` and guarantees the result is strictly
 * inside it. Every path derived from renderer input goes through here.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...segments)
  const relative = path.relative(resolvedRoot, target)
  const escapes =
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  if (escapes) {
    throw new PathEscapeError(target)
  }
  return target
}
