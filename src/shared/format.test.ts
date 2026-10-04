import { describe, expect, it } from 'vitest'
import { formatBytes, formatClock, formatTimecode } from './format'

describe('formatClock', () => {
  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [32_000, '00:32'],
    [725_000, '12:05'],
    [3_723_000, '1:02:03'],
    [-50, '00:00']
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatClock(ms)).toBe(expected)
  })
})

describe('formatTimecode', () => {
  it.each([
    [0, '00:00,0'],
    [3_449, '00:03,4'],
    [59_999, '00:59,9'],
    [61_250, '01:01,2'],
    [-10, '00:00,0']
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatTimecode(ms)).toBe(expected)
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [4_519_676, '4,5 MB'],
    [250_000_000, '250 MB'],
    [1_200_000_000, '1,2 GB']
  ])('formats %d bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})
