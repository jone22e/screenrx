import { describe, expect, it } from 'vitest'
import { parseVideoPackets } from './FfmpegService'

describe('parseVideoPackets', () => {
  it('reads timestamps, positions and keyframes', () => {
    const packets = parseVideoPackets('0.000000,48211,48,K_\n0.016667,1203,48259,__\n1.000000,50112,49462,K_\n')
    expect(packets).toEqual([
      { timestampUs: 0, offset: 48, size: 48211, keyframe: true },
      { timestampUs: 16667, offset: 48259, size: 1203, keyframe: false },
      { timestampUs: 1_000_000, offset: 49462, size: 50112, keyframe: true }
    ])
  })

  it('skips blank and malformed lines', () => {
    expect(parseVideoPackets('\n\nN/A,10,20,K_\n0.5,0,20,__\n0.5,10,20,__\n')).toEqual([
      { timestampUs: 500_000, offset: 20, size: 10, keyframe: false }
    ])
  })
})
