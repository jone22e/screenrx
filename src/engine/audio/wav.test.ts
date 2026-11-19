import { describe, expect, it } from 'vitest'
import { decodeWav16, encodeWav16, splitAtQuiet } from './wav'

describe('encodeWav16 / decodeWav16', () => {
  it('round-trips 16-bit mono samples', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768])
    const decoded = decodeWav16(encodeWav16(samples, 16_000))
    expect(decoded).not.toBeNull()
    expect(decoded?.sampleRate).toBe(16_000)
    expect(decoded?.channels).toBe(1)
    expect(Array.from(decoded?.samples ?? [])).toEqual(Array.from(samples))
  })

  it('scales floats to 16 bits and clips what is out of range', () => {
    const decoded = decodeWav16(encodeWav16(new Float32Array([0, 0.5, -0.5, 2, -2]), 8000))
    expect(Array.from(decoded?.samples ?? [])).toEqual([0, 16383, -16384, 32767, -32768])
  })

  it('refuses what is not a 16-bit PCM WAV', () => {
    expect(decodeWav16(new Uint8Array(10))).toBeNull()
    expect(decodeWav16(new TextEncoder().encode('RIFF....WAVEjunk'.padEnd(60, ' ')))).toBeNull()
    const bytes = encodeWav16(new Int16Array(4), 16_000)
    new DataView(bytes.buffer).setUint16(34, 8, true)
    expect(decodeWav16(bytes)).toBeNull()
  })
})

describe('splitAtQuiet', () => {
  const rate = 1000

  it('keeps short audio in one piece', () => {
    const pieces = splitAtQuiet(new Int16Array(rate * 5), rate, 10)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]?.startMs).toBe(0)
    expect(pieces[0]?.samples.length).toBe(rate * 5)
  })

  it('cuts where the sound is quietest near the end of each piece', () => {
    // 25 s loud, except silence between 7.0 s and 7.5 s and between 17.0 s and 17.5 s.
    const samples = new Int16Array(rate * 25).fill(10_000)
    samples.fill(0, rate * 7, rate * 7.5)
    samples.fill(0, rate * 17, rate * 17.5)
    const pieces = splitAtQuiet(samples, rate, 10, 4)
    expect(pieces).toHaveLength(3)
    expect(pieces[0]?.startMs).toBe(0)
    expect(pieces[1]?.startMs).toBeGreaterThanOrEqual(7000)
    expect(pieces[1]?.startMs).toBeLessThanOrEqual(7500)
    expect(pieces[2]?.startMs).toBeGreaterThanOrEqual(17_000)
    expect(pieces[2]?.startMs).toBeLessThanOrEqual(17_500)
    const total = pieces.reduce((sum, piece) => sum + piece.samples.length, 0)
    expect(total).toBe(samples.length)
  })
})
