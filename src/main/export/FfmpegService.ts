import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import ffmpegPath from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import type { Logger } from '../logging/logger'

export interface FfmpegBinaries {
  ffmpeg: string
  ffprobe: string
}

/**
 * The FFmpeg shipped with the app (never the user's own install). In a
 * packaged build, binaries live outside the archive.
 */
export function bundledFfmpegBinaries(): FfmpegBinaries {
  const unpacked = (binary: string): string => binary.replace('app.asar', 'app.asar.unpacked')
  if (!ffmpegPath) throw new Error('No bundled FFmpeg for this platform')
  return { ffmpeg: unpacked(ffmpegPath), ffprobe: unpacked(ffprobe.path) }
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    /** Last lines FFmpeg wrote before failing. */
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

export class FfmpegCancelledError extends Error {
  constructor() {
    super('FFmpeg was cancelled')
    this.name = 'FfmpegCancelledError'
  }
}

/** A running FFmpeg that is fed through stdin. */
export interface FfmpegProcess {
  readonly stdin: Writable
  /** Settles when FFmpeg exits: resolves on success, rejects with `FfmpegError` or `FfmpegCancelledError`. */
  readonly done: Promise<void>
  cancel(): void
}

export type H264Encoder = 'h264_videotoolbox' | 'libx264'

/** One encoded frame of a video stream, as located by FFprobe. */
export interface VideoPacket {
  timestampUs: number
  offset: number
  size: number
  keyframe: boolean
}

/** Enough to see where there is sound; this is for drawing, not listening. */
const PEAK_SAMPLE_RATE = 8000
const STDERR_TAIL_BYTES = 16 * 1024
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024 * 1024

/**
 * The only place that runs FFmpeg and FFprobe: finding the binaries,
 * spawning, capturing errors, cancelling. Nothing else in the app — and no
 * renderer — executes them directly.
 */
export class FfmpegService {
  private encoder: Promise<H264Encoder> | null = null

  constructor(
    private readonly binaries: FfmpegBinaries,
    private readonly logger: Logger
  ) {}

  /** Hardware encoding when this machine's FFmpeg offers it, software otherwise. */
  selectH264Encoder(): Promise<H264Encoder> {
    this.encoder ??= this.run(this.binaries.ffmpeg, ['-hide_banner', '-encoders']).then(
      (encoders): H264Encoder => {
        const encoder = /\bh264_videotoolbox\b/.test(encoders) ? 'h264_videotoolbox' : 'libx264'
        this.logger.info('selected encoder', { encoder })
        return encoder
      }
    )
    return this.encoder
  }

  /** Lists every packet of the first video stream: when it is shown and where it is in the file. */
  async probeVideoPackets(filePath: string): Promise<VideoPacket[]> {
    const output = await this.run(this.binaries.ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,size,pos,flags',
      '-of', 'csv=p=0',
      filePath
    ])
    return parseVideoPackets(output)
  }

  /**
   * The loudness outline of an audio file: `buckets` peaks between 0 and 1,
   * relative to its loudest moment. The audio is decoded to a low-rate mono
   * stream and reduced on the fly, so memory use does not depend on its length.
   */
  audioPeaks(filePath: string, durationMs: number, buckets: number): Promise<number[]> {
    const totalSamples = Math.max(1, Math.round((durationMs / 1000) * PEAK_SAMPLE_RATE))
    const samplesPerBucket = Math.max(1, Math.ceil(totalSamples / buckets))
    const peaks = new Array<number>(buckets).fill(0)

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.binaries.ffmpeg,
        ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let sampleIndex = 0
      let leftover: Buffer | null = null
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        // A chunk may end in the middle of a 16-bit sample.
        const data = leftover ? Buffer.concat([leftover, chunk]) : chunk
        const usable = data.length - (data.length % 2)
        for (let offset = 0; offset < usable; offset += 2) {
          const bucket = Math.min(buckets - 1, Math.floor(sampleIndex / samplesPerBucket))
          const amplitude = Math.abs(data.readInt16LE(offset))
          if (amplitude > (peaks[bucket] as number)) peaks[bucket] = amplitude
          sampleIndex += 1
        }
        leftover = usable < data.length ? data.subarray(usable) : null
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
      })
      child.once('error', (error) => reject(new FfmpegError(`FFmpeg could not start: ${error.message}`, '')))
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new FfmpegError(`FFmpeg exited with ${code}`, stderr))
          return
        }
        const loudest = Math.max(...peaks, 1)
        resolve(peaks.map((peak) => Math.round((peak / loudest) * 1000) / 1000))
      })
    })
  }

  /** Saves the frame shown at `timeSeconds` as a JPEG no wider than `maxWidthPx`. */
  async extractFrame(inputPath: string, outputPath: string, timeSeconds: number, maxWidthPx: number): Promise<void> {
    await this.run(this.binaries.ffmpeg, [
      '-v', 'error', '-y',
      '-ss', timeSeconds.toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidthPx},iw)':-2`,
      '-q:v', '4',
      outputPath
    ])
  }

  /** Starts FFmpeg with `args`, to be fed through its stdin. */
  spawn(args: string[]): FfmpegProcess {
    const child = spawn(this.binaries.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderrTail = ''
    let cancelled = false
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    // A failed FFmpeg closes its stdin; the exit handler below reports why.
    child.stdin.on('error', () => undefined)

    const done = new Promise<void>((resolve, reject) => {
      child.once('error', (error) => reject(new FfmpegError(`FFmpeg could not start: ${error.message}`, '')))
      child.once('exit', (code, signal) => {
        if (cancelled) reject(new FfmpegCancelledError())
        else if (code === 0) resolve()
        else reject(new FfmpegError(`FFmpeg exited with ${code ?? signal}`, stderrTail))
      })
    })
    // Callers await `done` when they are ready; never leave it unhandled before that.
    done.catch(() => undefined)

    return {
      stdin: child.stdin,
      done,
      cancel: () => {
        cancelled = true
        child.kill('SIGKILL')
      }
    }
  }

  private run(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let size = 0
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_PROBE_OUTPUT_BYTES) child.kill('SIGKILL')
        else chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
      })
      child.once('error', (error) => reject(new FfmpegError(`${binary} could not start: ${error.message}`, '')))
      child.once('exit', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
        else reject(new FfmpegError(`${binary} exited with ${code}`, stderr))
      })
    })
  }
}

/** Parses FFprobe's `pts_time,size,pos,flags` lines. */
export function parseVideoPackets(csv: string): VideoPacket[] {
  const packets: VideoPacket[] = []
  for (const line of csv.split('\n')) {
    const [time, size, position, flags] = line.trim().split(',')
    const seconds = Number(time)
    const bytes = Number(size)
    const offset = Number(position)
    if (!line.trim() || !Number.isFinite(seconds) || !(bytes > 0) || !(offset >= 0)) continue
    packets.push({
      timestampUs: Math.round(seconds * 1_000_000),
      offset,
      size: bytes,
      keyframe: (flags ?? '').startsWith('K')
    })
  }
  return packets
}
