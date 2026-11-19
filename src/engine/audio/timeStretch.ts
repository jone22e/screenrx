/**
 * Changes the tempo of audio without changing its pitch, as FFmpeg's
 * `atempo` does for the desktop export: the web editor runs this in the
 * browser instead. WSOLA — waveform-similarity overlap-add: the output is
 * built from windowed grains of the input, each taken where it lines up
 * best with the end of the grain before, so the waveform keeps its shape.
 */

/** Sizes of the grains and of the search, in seconds. */
const GRAIN_SEC = 0.04
const SEARCH_SEC = 0.008

/**
 * `channels` played `speed` times faster (2 is twice as fast, 0.5 half as
 * fast), one array per channel, all the same length. The grain positions are
 * chosen on the first channel and used on all of them, so stereo stays in
 * phase. 1x comes back as a copy.
 */
export function stretchChannels(channels: readonly Float32Array[], speed: number, sampleRate: number): Float32Array[] {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError(`Invalid speed ${speed}`)
  const first = channels[0]
  if (!first) return []
  const inputLength = first.length
  const outputLength = Math.round(inputLength / speed)
  if (Math.abs(speed - 1) < 1e-6 || inputLength === 0) return channels.map((channel) => channel.slice(0, outputLength))

  const grain = Math.max(16, Math.round(GRAIN_SEC * sampleRate))
  const hop = grain >> 1
  const search = Math.max(1, Math.round(SEARCH_SEC * sampleRate))
  const window = new Float32Array(grain)
  for (let index = 0; index < grain; index++) window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / grain)

  const outputs = channels.map(() => new Float32Array(outputLength + grain))
  const weight = new Float32Array(outputLength + grain)
  const reference = first
  // Where the previous grain was taken from, so the next one is looked for where it would continue.
  let previousStart = 0
  for (let out = 0, grainIndex = 0; out < outputLength; out += hop, grainIndex++) {
    const nominal = Math.round(out * speed)
    let start = Math.min(nominal, Math.max(0, inputLength - grain))
    if (grainIndex > 0) {
      // The natural continuation of the last grain, against which candidates are compared.
      const continuation = previousStart + hop
      let best = -Infinity
      let bestStart = start
      const low = Math.max(0, nominal - search)
      const high = Math.min(Math.max(0, inputLength - grain), nominal + search)
      for (let candidate = low; candidate <= high; candidate++) {
        let score = 0
        for (let index = 0; index < grain; index += 2) {
          score += (reference[continuation + index] ?? 0) * (reference[candidate + index] ?? 0)
        }
        if (score > best) {
          best = score
          bestStart = candidate
        }
      }
      start = bestStart
    }
    previousStart = start
    for (const [channelIndex, channel] of channels.entries()) {
      const output = outputs[channelIndex] as Float32Array
      for (let index = 0; index < grain; index++) {
        const sample = channel[start + index]
        if (sample === undefined) break
        output[out + index] = (output[out + index] ?? 0) + sample * (window[index] as number)
      }
    }
    for (let index = 0; index < grain; index++) weight[out + index] = (weight[out + index] ?? 0) + (window[index] as number)
  }

  return outputs.map((output) => {
    const trimmed = new Float32Array(outputLength)
    for (let index = 0; index < outputLength; index++) {
      const total = weight[index] as number
      trimmed[index] = total > 1e-3 ? (output[index] as number) / total : (output[index] as number)
    }
    return trimmed
  })
}
