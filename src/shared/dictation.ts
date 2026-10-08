/**
 * Dictation: what the assistant's microphone records becomes text through the
 * native transcriber, on this Mac. Here is what does not depend on Electron:
 * the WAV the transcriber reads.
 */

/** Sample rate the audio is sent at: speech needs no more, and the file stays small. */
export const DICTATION_RATE = 16_000
/** The longest dictation accepted, in seconds. */
export const DICTATION_MAX_SECONDS = 10 * 60

/** 16-bit PCM WAV, mono, from samples between −1 and 1. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const ascii = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index++) view.setUint8(at + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(view.buffer)
}
