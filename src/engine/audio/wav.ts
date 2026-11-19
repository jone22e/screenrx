/**
 * WAV files with 16-bit PCM: the form the web editor sends speech in and the
 * server reads it back from. Nothing more of the format is handled.
 */

export interface PcmWav {
  sampleRate: number
  channels: number
  /** Interleaved samples. */
  samples: Int16Array
}

/** Bytes per sample of 16-bit PCM. */
const BYTES_PER_SAMPLE = 2

/** Writes `samples` (floats in −1…1, or 16-bit integers) as a WAV file. */
export function encodeWav16(samples: Float32Array | Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true)
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  if (samples instanceof Int16Array) {
    for (let index = 0; index < samples.length; index++, offset += 2) view.setInt16(offset, samples[index] as number, true)
  } else {
    for (let index = 0; index < samples.length; index++, offset += 2) {
      const value = Math.max(-1, Math.min(1, samples[index] as number))
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    }
  }
  return bytes
}

/** Reads a 16-bit PCM WAV file; `null` when the bytes are not one. */
export function decodeWav16(bytes: Uint8Array): PcmWav | null {
  if (bytes.length < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let offset = 12
  let format: { channels: number; sampleRate: number } | null = null
  while (offset + 8 <= bytes.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) return null
      const encoding = view.getUint16(body, true)
      const bits = view.getUint16(body + 14, true)
      if (encoding !== 1 || bits !== 16) return null
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true) }
    } else if (id === 'data') {
      if (!format || format.channels < 1 || format.sampleRate < 1) return null
      const available = Math.min(size, bytes.length - body)
      const count = Math.floor(available / BYTES_PER_SAMPLE)
      const samples = new Int16Array(count)
      for (let index = 0; index < count; index++) samples[index] = view.getInt16(body + index * BYTES_PER_SAMPLE, true)
      return { sampleRate: format.sampleRate, channels: format.channels, samples }
    }
    offset = body + size + (size % 2)
  }
  return null
}

export interface WavPiece {
  /** Where the piece starts in the whole, in milliseconds. */
  startMs: number
  samples: Int16Array
}

/**
 * Splits mono audio into pieces of at most `maxSeconds`, cutting where the
 * sound is quietest in the last `searchSeconds` of each piece, so a word is
 * not cut in two. One piece when it all fits.
 */
export function splitAtQuiet(samples: Int16Array, sampleRate: number, maxSeconds: number, searchSeconds = 10): WavPiece[] {
  const max = Math.max(sampleRate, Math.floor(maxSeconds * sampleRate))
  const window = Math.max(1, Math.floor(sampleRate * 0.02))
  const pieces: WavPiece[] = []
  let start = 0
  while (samples.length - start > max) {
    const search = Math.min(max, Math.max(window, Math.floor(searchSeconds * sampleRate)))
    const from = start + max - search
    const to = start + max
    let quietest = to
    let lowest = Infinity
    for (let at = from; at + window <= to; at += window) {
      let energy = 0
      for (let index = at; index < at + window; index++) {
        const value = samples[index] as number
        energy += value * value
      }
      if (energy < lowest) {
        lowest = energy
        quietest = at + Math.floor(window / 2)
      }
    }
    pieces.push({ startMs: (start / sampleRate) * 1000, samples: samples.subarray(start, quietest) })
    start = quietest
  }
  pieces.push({ startMs: (start / sampleRate) * 1000, samples: samples.subarray(start) })
  return pieces
}
