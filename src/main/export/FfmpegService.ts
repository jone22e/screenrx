import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import ffmpegPath from 'ffmpeg-static'
import ffprobe from '@ffprobe-installer/ffprobe'
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

/** What FFprobe finds in a media file: its length and its first video and audio streams. */
export interface MediaProbe {
  durationMs: number
  video: {
    codec: string
    pixelFormat: string | null
    widthPx: number
    heightPx: number
    /** Average frame rate; 0 when the file does not say. */
    fps: number
  } | null
  audio: { codec: string } | null
}

/** One encoded frame of a video stream, as located by FFprobe. */
export interface VideoPacket {
  timestampUs: number
  offset: number
  size: number
  keyframe: boolean
}

/** Enough to see where there is sound; this is for drawing, not listening. */
const PEAK_SAMPLE_RATE = 8000
/** How a track is assembled from clips. */
const CLIP_MIX = { clipsPerMix: 48, sampleRate: 48_000, bitrate: 128_000 } as const

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

  /** Cuts `[startMs, endMs)` of an audio file into a mono WAV at `sampleRate`. */
  async extractAudioClip(
    inputPath: string,
    outputPath: string,
    startMs: number,
    endMs: number,
    sampleRate: number
  ): Promise<void> {
    await this.run(this.binaries.ffmpeg, [
      '-v', 'error', '-y',
      '-ss', (startMs / 1000).toFixed(3),
      '-to', (endMs / 1000).toFixed(3),
      '-i', inputPath,
      '-ac', '1', '-ar', String(sampleRate),
      outputPath
    ])
  }

  /**
   * Runs `filterComplex` (which must end in an `[out]` audio label) over the first audio stream of
   * `inputPath` and writes the result as AAC in an MP4 container, like the other audio tracks.
   */
  async renderAudio(inputPath: string, outputPath: string, filterComplex: string): Promise<void> {
    await this.run(this.binaries.ffmpeg, [
      '-v', 'error', '-y',
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-ar', '48000', '-ac', '2',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath
    ])
  }

  /** Streams and length of any media file FFprobe can open; throws when it cannot. */
  async probeMedia(filePath: string): Promise<MediaProbe> {
    const output = await this.run(this.binaries.ffprobe, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate:format=duration',
      '-of', 'json',
      filePath
    ])
    const probe = parseMediaProbe(output)
    if (!probe) throw new FfmpegError('FFprobe reported no usable media', output)
    return probe
  }

  /**
   * Writes the first video stream of `inputPath` alone (no audio) as H.264 in an MP4, the form the
   * editor and the export read. The stream is copied untouched when `copy` is set, re-encoded at
   * `bitrate` bits per second otherwise.
   */
  async writeVideoTrack(
    inputPath: string,
    outputPath: string,
    options: { copy: boolean; bitrate: number }
  ): Promise<void> {
    // 4:2:0 needs even dimensions; an odd edge loses one pixel rather than failing the whole import.
    const evenSize = ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p']
    const codec = options.copy
      ? ['-c:v', 'copy']
      : (await this.selectH264Encoder()) === 'h264_videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-b:v', String(options.bitrate), '-profile:v', 'high', '-allow_sw', '1', ...evenSize]
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', ...evenSize]
    await this.run(this.binaries.ffmpeg, [
      '-v', 'error', '-y',
      '-i', inputPath,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      ...codec,
      '-movflags', '+faststart',
      '-f', 'mp4',
      outputPath
    ])
  }

  /**
   * Writes the first audio stream of `inputPath` alone as AAC in an MP4 container, like the recorded
   * audio tracks. The stream is copied untouched when `copy` is set, re-encoded otherwise.
   */
  async writeAudioTrack(inputPath: string, outputPath: string, copy: boolean): Promise<void> {
    const codec = copy ? ['-c:a', 'copy'] : ['-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k']
    await this.run(this.binaries.ffmpeg, [
      '-v', 'error', '-y',
      '-i', inputPath,
      '-map', '0:a:0', '-vn', '-sn', '-dn',
      ...codec,
      '-movflags', '+faststart',
      '-f', 'mp4',
      outputPath
    ])
  }

  /** The duration of a media file, in milliseconds. */
  async durationOf(filePath: string): Promise<number> {
    const output = await this.run(this.binaries.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
    ])
    const seconds = Number(output.trim())
    if (!Number.isFinite(seconds)) throw new FfmpegError('FFprobe reported no duration', output)
    return seconds * 1000
  }

  /**
   * Lays audio clips on one track: each starts at its `startMs`, the rest is
   * silence, and the track lasts exactly `durationMs`. Written as AAC in an
   * MP4 container, or as WAV when `outputPath` ends in `.wav`.
   *
   * FFmpeg opens every input at once, so a long list is mixed in groups and
   * the groups are then mixed together.
   */
  async mixClips(
    clips: ReadonlyArray<{ path: string; startMs: number }>,
    durationMs: number,
    outputPath: string
  ): Promise<void> {
    const { clipsPerMix, sampleRate, bitrate } = CLIP_MIX
    if (clips.length > clipsPerMix) {
      const stems: Array<{ path: string; startMs: number }> = []
      try {
        for (let start = 0; start < clips.length; start += clipsPerMix) {
          const stem = `${outputPath}.stem-${stems.length}.wav`
          stems.push({ path: stem, startMs: 0 })
          await this.mixClips(clips.slice(start, start + clipsPerMix), durationMs, stem)
        }
        await this.mixClips(stems, durationMs, outputPath)
      } finally {
        await Promise.all(stems.map((stem) => rm(stem.path, { force: true })))
      }
      return
    }

    const seconds = (durationMs / 1000).toFixed(3)
    // The graph goes in a file: with many clips it is far longer than a command line should be.
    const graphPath = `${outputPath}.graph.txt`
    const graph =
      clips.length === 0
        ? `anullsrc=channel_layout=mono:sample_rate=${sampleRate},atrim=0:${seconds}[out]`
        : [
            ...clips.map(
              (clip, index) =>
                `[${index}:a]aresample=${sampleRate},aformat=channel_layouts=mono,adelay=${Math.round(clip.startMs)}:all=1[c${index}]`
            ),
            `${clips.map((_, index) => `[c${index}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=0:${seconds}[out]`
          ].join(';\n')
    await writeFile(graphPath, graph)
    try {
      await this.run(this.binaries.ffmpeg, [
        '-v', 'error', '-y',
        ...clips.flatMap((clip) => ['-i', clip.path]),
        '-filter_complex_script', graphPath,
        '-map', '[out]',
        ...(outputPath.endsWith('.wav') ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', String(bitrate), '-f', 'mp4']),
        outputPath
      ])
    } finally {
      await rm(graphPath, { force: true })
    }
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

/** Reads FFprobe's JSON for `probeMedia`; `null` when it describes no media at all. */
export function parseMediaProbe(json: string): MediaProbe | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { streams, format } = parsed as { streams?: unknown; format?: { duration?: unknown } }
  if (!Array.isArray(streams)) return null
  const seconds = Number(format?.duration)
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0

  const video = (streams as Array<Record<string, unknown>>).find((stream) => stream['codec_type'] === 'video')
  const audio = (streams as Array<Record<string, unknown>>).find((stream) => stream['codec_type'] === 'audio')
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  const size = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0)
  const videoCodec = text(video?.['codec_name'])
  const widthPx = size(video?.['width'])
  const heightPx = size(video?.['height'])
  const audioCodec = text(audio?.['codec_name'])
  if (!video && !audio) return null
  return {
    durationMs,
    video:
      videoCodec && widthPx > 0 && heightPx > 0
        ? {
            codec: videoCodec,
            pixelFormat: text(video?.['pix_fmt']),
            widthPx,
            heightPx,
            fps: parseFrameRate(video?.['avg_frame_rate'])
          }
        : null,
    audio: audioCodec ? { codec: audioCodec } : null
  }
}

/** FFprobe writes frame rates as a fraction, e.g. `30000/1001`; `0/0` means unknown. */
function parseFrameRate(value: unknown): number {
  if (typeof value !== 'string') return 0
  const [numerator, denominator = '1'] = value.split('/')
  const fps = Number(numerator) / Number(denominator)
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0
}
