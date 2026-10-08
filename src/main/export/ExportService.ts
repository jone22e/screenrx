import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { FileHandle } from 'node:fs/promises'
import { open, rename, rm, stat } from 'node:fs/promises'
import { buildAudioGraph } from '@engine/export/audioFilters'
import type { ExportPlan } from '@engine/export/exportPlan'
import { createExportPlan } from '@engine/export/exportPlan'
import { buildTimeMap } from '@engine/time/timeMapping'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { ExportJob, ExportResult, ExportTrack, ExportTrackName } from '@shared/models/export'
import { DUB_TRACKS } from '@shared/models/media'
import type { Logger } from '../logging/logger'
import type { ProjectStore } from '../project/ProjectStore'
import type { SessionStore } from '../recording/SessionStore'
import type { FfmpegProcess, FfmpegService, VideoEncoder } from './FfmpegService'
import { FfmpegCancelledError, FfmpegError } from './FfmpegService'
import { readAvcConfiguration } from './mp4'

/** A failure of the export, already translated for the user. */
export class ExportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ? `${appError.code}: ${appError.detail}` : appError.code)
    this.name = 'ExportError'
  }
}

export interface ExportServiceDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  projects: ProjectStore
  logger: Logger
  /** Asks the user where to save; `null` when they give up. */
  chooseOutputPath: (suggestedFileName: string) => Promise<string | null>
}

interface ActiveExport {
  id: string
  sessionId: string
  plan: ExportPlan
  process: FfmpegProcess
  /** FFmpeg writes here; the file only takes its final name once complete. */
  partialPath: string
  outputPath: string
  files: Partial<Record<ExportTrackName, { handle: FileHandle; size: number }>>
  framesWritten: number
  startedAt: number
}

/** Largest slice of a track the renderer may ask for at once. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024
const BYTES_PER_PIXEL = 4

/**
 * Runs an export. The renderer draws every output frame — with the same
 * code as the preview — and streams it here as raw pixels; FFmpeg encodes
 * the frames once, processes the audio (cuts, tempo with pitch preserved),
 * and muxes the MP4. Frames flow through with back-pressure, so memory use
 * does not depend on the length of the recording.
 */
export class ExportService {
  private active: ActiveExport | null = null
  private readonly finished = new Map<string, string>()

  constructor(private readonly deps: ExportServiceDeps) {}

  /** Whether an export is running right now. */
  isRunning(): boolean {
    return this.active !== null
  }

  async start(sessionId: string): Promise<ExportJob> {
    if (this.active) throw new ExportError(appError('export-busy'))
    const { ffmpeg, sessions, projects, logger } = this.deps

    const session = await projects.open(sessionId)
    const { project } = session
    const map = buildTimeMap(session.durationMs, project.effects)
    const plan = createExportPlan(
      { width: session.video.widthPx, height: session.video.heightPx },
      map,
      project.export,
      project.background.aspect
    )

    const fileName = suggestedFileName(session.title, session.createdAt, plan.speed)
    const outputPath = await this.deps.chooseOutputPath(fileName)
    if (!outputPath) throw new ExportError(appError('export-cancelled'))

    const files: ActiveExport['files'] = {}
    try {
      const screenPath = sessions.trackPathOf(sessionId, 'screen')
      const screen = await this.describeTrack(screenPath, session.video)
      files.screen = await openTrack(screenPath)

      let webcam: ExportTrack | null = null
      if (session.webcam && project.webcam.visible) {
        const webcamPath = sessions.trackPathOf(sessionId, 'webcam')
        webcam = await this.describeTrack(webcamPath, session.webcam)
        files.webcam = await openTrack(webcamPath)
      }

      // A track muted in the edit is simply not given to the encoder. A dubbing in
      // use takes the place of the recorded voice.
      const dub = session.dubs.find((track) => track.language === project.dub.language)
      const audioPaths = session.audio
        .filter((track) => !project.audio[track.kind].muted && !(dub && track.kind === 'microphone'))
        .map((track) => sessions.trackPathOf(sessionId, track.kind))
      if (dub) audioPaths.push(sessions.trackPathOf(sessionId, DUB_TRACKS[dub.language]))
      const encoder = await ffmpeg.selectVideoEncoder(plan.codec)
      const partialPath = `${outputPath}.part`
      const process = ffmpeg.spawn(encodeArguments(plan, encoder, audioPaths, map, partialPath))

      const id = randomUUID()
      this.active = { id, sessionId, plan, process, partialPath, outputPath, files, framesWritten: 0, startedAt: Date.now() }
      logger.info('started', {
        sessionId,
        size: `${plan.width}x${plan.height}`,
        frames: plan.frameCount,
        speed: plan.speed,
        encoder,
        audioTracks: audioPaths.length
      })
      return { exportId: id, plan, encoder, fileName: baseName(outputPath), screen, webcam }
    } catch (error) {
      await closeTracks(files)
      throw toExportError(error)
    }
  }

  /** A slice of one of the tracks being exported, for the renderer's decoder. */
  async readChunk(exportId: string, track: ExportTrackName, offset: number, length: number): Promise<Uint8Array> {
    const file = this.require(exportId).files[track]
    const valid =
      file !== undefined &&
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length > 0 &&
      length <= MAX_CHUNK_BYTES &&
      offset + length <= file.size
    if (!valid) throw new ExportError(appError('export-failed', 'invalid chunk request'))
    const buffer = Buffer.allocUnsafe(length)
    await file.handle.read(buffer, 0, length, offset)
    return buffer
  }

  /** Appends one finished frame (RGBA, exactly the planned size). */
  async writeFrame(exportId: string, frame: Uint8Array): Promise<void> {
    const active = this.require(exportId)
    const expectedBytes = active.plan.width * active.plan.height * BYTES_PER_PIXEL
    if (frame.byteLength !== expectedBytes || active.framesWritten >= active.plan.frameCount) {
      await this.abort(active)
      throw new ExportError(appError('export-failed', 'unexpected frame'))
    }
    try {
      if (!active.process.stdin.write(frame)) {
        // Wait for FFmpeg to catch up — or to die, which must not hang the export.
        await Promise.race([once(active.process.stdin, 'drain'), active.process.done.then(rejectEarlyExit)])
      }
      active.framesWritten += 1
    } catch (error) {
      await this.abort(active)
      throw toExportError(error)
    }
  }

  async finish(exportId: string): Promise<ExportResult> {
    const active = this.require(exportId)
    try {
      if (active.framesWritten === 0) throw new ExportError(appError('export-failed', 'no frames were rendered'))
      active.process.stdin.end()
      await active.process.done
      await rename(active.partialPath, active.outputPath)
      const { size } = await stat(active.outputPath)
      this.finished.set(active.id, active.outputPath)
      await this.deps.sessions.recordExport(active.sessionId).catch(() => undefined)
      this.deps.logger.info('finished', {
        frames: active.framesWritten,
        bytes: size,
        seconds: Math.round((Date.now() - active.startedAt) / 100) / 10
      })
      return { exportId: active.id, fileName: baseName(active.outputPath), sizeBytes: size }
    } catch (error) {
      await this.abort(active)
      throw toExportError(error)
    } finally {
      await this.release(active)
    }
  }

  /** Stops the export in progress (if it is `exportId`, or whichever it is) and removes its partial file. */
  async cancel(exportId?: string): Promise<void> {
    const active = this.active
    if (!active || (exportId !== undefined && active.id !== exportId)) return
    this.deps.logger.info('cancelled', { frames: active.framesWritten })
    await this.abort(active)
  }

  /** Where a finished export was saved. */
  pathOf(exportId: string): string | null {
    return this.finished.get(exportId) ?? null
  }

  private require(exportId: string): ActiveExport {
    if (!this.active || this.active.id !== exportId) {
      throw new ExportError(appError('export-failed', 'no such export'))
    }
    return this.active
  }

  private async abort(active: ActiveExport): Promise<void> {
    active.process.cancel()
    await active.process.done.catch(() => undefined)
    await rm(active.partialPath, { force: true })
    await this.release(active)
  }

  private async release(active: ActiveExport): Promise<void> {
    if (this.active === active) this.active = null
    await closeTracks(active.files)
    active.files = {}
  }

  private async describeTrack(
    filePath: string,
    dimensions: { widthPx: number; heightPx: number }
  ): Promise<ExportTrack> {
    const [packets, configuration, { size }] = await Promise.all([
      this.deps.ffmpeg.probeVideoPackets(filePath),
      readAvcConfiguration(filePath),
      stat(filePath)
    ])
    if (packets.length === 0 || !packets[0]?.keyframe) {
      throw new ExportError(appError('export-failed', 'track has no decodable frames'))
    }
    return {
      codec: configuration.codec,
      description: configuration.description,
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      fileSizeBytes: size,
      timestampsUs: packets.map((packet) => packet.timestampUs),
      offsets: packets.map((packet) => packet.offset),
      sizes: packets.map((packet) => packet.size),
      keyframes: packets.map((packet) => packet.keyframe)
    }
  }
}

function rejectEarlyExit(): never {
  throw new FfmpegError('FFmpeg exited before the export finished', '')
}

async function openTrack(filePath: string): Promise<{ handle: FileHandle; size: number }> {
  const handle = await open(filePath, 'r')
  return { handle, size: (await handle.stat()).size }
}

async function closeTracks(files: ActiveExport['files']): Promise<void> {
  await Promise.all(Object.values(files).map((file) => file.handle.close().catch(() => undefined)))
}

/** The codec's arguments: hardware encoders take a bitrate, the software ones a quality. */
function videoArguments(encoder: VideoEncoder, bitrate: number): string[] {
  switch (encoder) {
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-b:v', String(bitrate), '-profile:v', 'high', '-allow_sw', '1']
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high']
    // `hvc1`: the tag QuickTime and the iPhone look for; without it the file is HEVC they refuse.
    case 'hevc_videotoolbox':
      return ['-c:v', 'hevc_videotoolbox', '-b:v', String(bitrate), '-allow_sw', '1', '-tag:v', 'hvc1']
    case 'libx265':
      return ['-c:v', 'libx265', '-preset', 'medium', '-crf', '24', '-tag:v', 'hvc1']
  }
}

/**
 * One FFmpeg run for the whole file: raw frames in on stdin, the session's
 * audio tracks as further inputs, H.264 (or HEVC, for the compact file) + AAC out.
 */
export function encodeArguments(
  plan: ExportPlan,
  encoder: VideoEncoder,
  audioPaths: readonly string[],
  map: ReturnType<typeof buildTimeMap>,
  outputPath: string
): string[] {
  // Input 0 is the video; audio inputs follow.
  const audio = buildAudioGraph(audioPaths.map((_, index) => index + 1), map, plan.speed)
  const video = videoArguments(encoder, plan.videoBitrate)

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-video_size', `${plan.width}x${plan.height}`,
    '-framerate', String(plan.fps),
    '-i', 'pipe:0',
    ...audioPaths.flatMap((audioPath) => ['-i', audioPath]),
    ...(audio ? ['-filter_complex', audio.filter, '-map', '0:v', '-map', audio.output] : ['-map', '0:v']),
    ...video,
    // yuv420p plays everywhere; the conversion and the tags agree on BT.709.
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...(audio ? ['-c:a', 'aac', '-b:a', String(plan.audioBitrate)] : []),
    '-t', (plan.outputDurationMs / 1000).toFixed(3),
    '-movflags', '+faststart',
    '-f', 'mp4',
    outputPath
  ]
}

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1)
}

/** `Display 1 2026-10-03 21.29 2x.mp4`, safe on every file system. */
export function suggestedFileName(title: string, createdAt: string, speed: number): string {
  const date = new Date(createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = Number.isNaN(date.getTime())
    ? ''
    : ` ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`
  const printable = [...title].filter((character) => character.charCodeAt(0) >= 32).join('')
  const safeTitle = printable.replace(/[/\\:*?"<>|]/g, '-').trim().slice(0, 80) || 'Gravação'
  const suffix = speed === 1 ? '' : ` ${String(speed).replace('.', ',')}x`
  return `${safeTitle}${stamp}${suffix}.mp4`
}

function toExportError(error: unknown): ExportError {
  if (error instanceof ExportError) return error
  if (error instanceof FfmpegCancelledError) return new ExportError(appError('export-cancelled'))
  if (error instanceof FfmpegError) {
    const diskFull = /No space left on device/i.test(error.stderrTail)
    return new ExportError(appError(diskFull ? 'disk-full' : 'export-failed', error.stderrTail.trim() || error.message))
  }
  const code = (error as NodeJS.ErrnoException).code
  return new ExportError(appError(code === 'ENOSPC' ? 'disk-full' : 'export-failed', String(error)))
}
