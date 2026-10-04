import { describe, expect, it } from 'vitest'
import { parseByteRange } from './byteRange'

describe('parseByteRange', () => {
  it.each([
    ['bytes=0-499', { start: 0, end: 499 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=-200', { start: 800, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }]
  ])('parses %s', (header, expected) => {
    expect(parseByteRange(header, 1000)).toEqual(expected)
  })

  it.each([null, '', 'bytes=-', 'bytes=abc-', 'items=0-1', 'bytes=0-1,5-9', 'bytes=1000-', 'bytes=5-2'])(
    'rejects %j',
    (header) => {
      expect(parseByteRange(header, 1000)).toBeNull()
    }
  )

  it('rejects any range of an empty resource', () => {
    expect(parseByteRange('bytes=0-', 0)).toBeNull()
  })
})
