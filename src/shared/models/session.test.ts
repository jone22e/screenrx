import { describe, expect, it } from 'vitest'
import { SESSION_TITLE_MAX_LENGTH, normalizeSessionTitle } from './session'

describe('normalizeSessionTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeSessionTitle('  Demo   do  produto \n')).toBe('Demo do produto')
  })

  it('returns null for an empty or blank name, and for anything that is not a string', () => {
    expect(normalizeSessionTitle('')).toBeNull()
    expect(normalizeSessionTitle('   ')).toBeNull()
    expect(normalizeSessionTitle(undefined)).toBeNull()
    expect(normalizeSessionTitle(42)).toBeNull()
  })

  it('cuts a long name to the maximum length', () => {
    const title = normalizeSessionTitle('a'.repeat(SESSION_TITLE_MAX_LENGTH + 50))
    expect(title).toHaveLength(SESSION_TITLE_MAX_LENGTH)
  })
})
