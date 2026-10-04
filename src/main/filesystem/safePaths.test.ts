import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathEscapeError, isSafeFileName, resolveInside } from './safePaths'

const root = path.resolve('/data/recordings')

describe('resolveInside', () => {
  it('resolves paths under the root', () => {
    expect(resolveInside(root, 'recording-1', 'screen.mp4')).toBe(
      path.join(root, 'recording-1', 'screen.mp4')
    )
  })

  it.each([
    ['parent traversal', ['..']],
    ['nested traversal', ['recording-1', '..', '..', 'etc']],
    ['traversal back into a sibling', ['..', 'recordings-evil', 'x']],
    ['absolute path', ['/etc/passwd']],
    ['the root itself', ['.']]
  ])('rejects %s', (_name, segments) => {
    expect(() => resolveInside(root, ...segments)).toThrow(PathEscapeError)
  })

  it('allows names that merely start with dots', () => {
    expect(resolveInside(root, '..hidden')).toBe(path.join(root, '..hidden'))
  })
})

describe('isSafeFileName', () => {
  it('accepts plain file names', () => {
    expect(isSafeFileName('screen.mp4')).toBe(true)
  })

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256)])('rejects %j', (name) => {
    expect(isSafeFileName(name)).toBe(false)
  })
})
