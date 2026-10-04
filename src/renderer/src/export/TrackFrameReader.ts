import type { ExportTrack } from '@shared/models/export'

export type ReadChunk = (offset: number, length: number) => Promise<Uint8Array>

/** How much of the file to pull per request; many frames fit in one. */
const CHUNK_BYTES = 8 * 1024 * 1024
/** Frames handed to the decoder per step, and how far ahead it may run. */
const DECODE_BATCH = 6
const MAX_PENDING_DECODES = 12
/** If the decoder is holding frames back, feed it more rather than wait forever. */
const OUTPUT_WAIT_MS = 40

/**
 * Reads a recorded video track frame by frame for export.
 *
 * It decodes the track sequentially with the platform's hardware decoder
 * and answers "which frame is on screen at this instant?" for increasing
 * instants — exactly, and without holding more than a handful of frames:
 * the encoded data is pulled from disk in chunks and each decoded frame is
 * released as soon as a later one replaces it.
 */
export class TrackFrameReader {
  private readonly decoder: VideoDecoder
  private readonly keyframeIndexes: number[]
  private queue: VideoFrame[] = []
  private current: VideoFrame | null = null
  private nextSample = 0
  private flushed = false
  private failure: Error | null = null
  private wake: (() => void) | null = null
  private chunk: { offset: number; data: Uint8Array } | null = null

  constructor(
    private readonly track: ExportTrack,
    private readonly readChunk: ReadChunk
  ) {
    this.keyframeIndexes = track.keyframes.flatMap((keyframe, index) => (keyframe ? [index] : []))
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push(frame)
        this.wake?.()
      },
      error: (error) => {
        this.failure = error
        this.wake?.()
      }
    })
    this.configure()
  }

  /**
   * The frame displayed at `timeUs`: the latest one whose timestamp is not
   * after it. Calls must not go back in time. The returned frame stays valid
   * only until the next call.
   */
  async frameAt(timeUs: number): Promise<VideoFrame | null> {
    this.skipAheadTo(timeUs)
    for (;;) {
      if (this.failure) throw this.failure
      let next = this.queue[0]
      while (next && next.timestamp <= timeUs) {
        this.current?.close()
        this.current = this.queue.shift() ?? null
        next = this.queue[0]
      }
      // A later frame is already decoded, so `current` is what is on screen.
      if (next) return this.current ?? next

      if (this.nextSample < this.track.sizes.length) {
        await this.feed()
      } else if (!this.flushed) {
        this.flushed = true
        await this.decoder.flush()
      } else {
        return this.current
      }
    }
  }

  close(): void {
    this.current?.close()
    for (const frame of this.queue) frame.close()
    this.queue = []
    this.current = null
    if (this.decoder.state !== 'closed') this.decoder.close()
  }

  private configure(): void {
    this.decoder.configure({
      codec: this.track.codec,
      description: this.track.description,
      codedWidth: this.track.widthPx,
      codedHeight: this.track.heightPx,
      hardwareAcceleration: 'prefer-hardware'
    })
  }

  /**
   * When the requested instant lies beyond a later keyframe (after a cut, or
   * at a high speed), restart there instead of decoding everything in between.
   */
  private skipAheadTo(timeUs: number): void {
    let keyframe = -1
    for (const index of this.keyframeIndexes) {
      if ((this.track.timestampsUs[index] ?? Infinity) > timeUs) break
      keyframe = index
    }
    if (keyframe <= this.nextSample) return
    this.decoder.reset()
    this.configure()
    for (const frame of this.queue) frame.close()
    this.queue = []
    this.nextSample = keyframe
    this.flushed = false
  }

  private async feed(): Promise<void> {
    const total = this.track.sizes.length
    for (
      let fed = 0;
      fed < DECODE_BATCH && this.nextSample < total && this.decoder.decodeQueueSize < MAX_PENDING_DECODES;
      fed++
    ) {
      const index = this.nextSample
      const data = await this.sampleData(index)
      this.decoder.decode(
        new EncodedVideoChunk({
          type: this.track.keyframes[index] ? 'key' : 'delta',
          timestamp: this.track.timestampsUs[index] ?? 0,
          data
        })
      )
      this.nextSample += 1
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, OUTPUT_WAIT_MS)
      this.wake = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
    })
  }

  private async sampleData(index: number): Promise<Uint8Array> {
    const offset = this.track.offsets[index] ?? 0
    const size = this.track.sizes[index] ?? 0
    const loaded = this.chunk
    if (!loaded || offset < loaded.offset || offset + size > loaded.offset + loaded.data.byteLength) {
      const length = Math.min(Math.max(CHUNK_BYTES, size), this.track.fileSizeBytes - offset)
      this.chunk = { offset, data: await this.readChunk(offset, length) }
    }
    const { offset: start, data } = this.chunk as { offset: number; data: Uint8Array }
    return data.subarray(offset - start, offset - start + size)
  }
}
