import { describe, expect, it } from 'vitest'
import { DICTATION_RATE, encodeWav } from './dictation'

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header and the samples, clipped', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), DICTATION_RATE)
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(10)
    expect(wav.byteLength).toBe(44 + 10)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff))
    expect(view.getInt16(48, true)).toBe(-0.5 * 0x8000)
    expect(view.getInt16(50, true)).toBe(0x7fff)
    expect(view.getInt16(52, true)).toBe(-0x8000)
  })
})
