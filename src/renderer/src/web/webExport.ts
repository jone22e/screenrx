import { mixdown } from '@engine/audio/mixdown'
import type { MixdownInput, MixdownTrack } from '@engine/audio/mixdown'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { suggestedFileName } from '@engine/export/exportFileName'
import { createExportPlan } from '@engine/export/exportPlan'
import type { ExportPlan } from '@engine/export/exportPlan'
import { describeMp4 } from '@engine/mp4/mp4Demux'
import { buildTimeMap } from '@engine/time/timeMapping'
import { appError } from '@shared/models/errors'
import type { AppError } from '@shared/models/errors'
import type { ExportJob, ExportOverrides, ExportResult, ExportTrack, ExportTrackName } from '@shared/models/export'
import { clipTrackName } from '@shared/models/export'
import { needsRenderedTrack } from '@shared/models/filters'
import type { Project } from '@shared/models/project'
import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer'
import { chooseSaveFile, downloadBlob } from './files'
import { blobSource, webSessions } from './sessions'
import type { OpenedVideo } from './sessions'

export class WebExportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'WebExportError'
  }
}

/** A keyframe this often, so the file seeks well. */
const KEYFRAME_INTERVAL_SEC = 2
/** Frames the encoder may hold before the renderer waits for it. */
const MAX_ENCODE_QUEUE = 6
/** Samples per `AudioData` handed to the encoder. */
const AUDIO_CHUNK_FRAMES = 4096
const MP4_KIND = { mime: 'video/mp4', extensions: ['.mp4'] }

type Target = ArrayBufferTarget | FileSystemWritableFileStreamTarget

interface ActiveExport {
  id: string
  video: OpenedVideo
  plan: ExportPlan
  fileName: string
  muxer: Muxer<Target>
  target: Target
  handle: FileSystemFileHandle | null
  writable: FileSystemWritableFileStream | null
  encoder: VideoEncoder
  frameIndex: number
  failure: Error | null
  /** The sound, decoded and mixed while the frames are drawn; `null` when the file has none. */
  audio: Promise<AudioOutcome> | null
  /** The bytes of each track being read, by name. */
  blobs: Map<ExportTrackName, Blob>
}

type AudioOutcome = { kind: 'done'; samples: number } | { kind: 'none' } | { kind: 'failed'; reason: string }

/** The encoder configurations tried for each codec the plan may ask for, most capable first. */
function videoConfigs(plan: ExportPlan): Array<{ label: string; config: VideoEncoderConfig }> {
  const base = {
    width: plan.width,
    height: plan.height,
    bitrate: plan.videoBitrate,
    framerate: plan.fps,
    latencyMode: 'quality' as const
  }
  const h264 = {
    label: 'H.264',
    // High profile; level 5.1 covers 4K at 30 fps, 5.2 is for more.
    config: { ...base, codec: plan.width * plan.height * plan.fps > 983_040 * 256 ? 'avc1.640034' : 'avc1.640033', avc: { format: 'avc' as const } }
  }
  if (plan.codec !== 'hevc') return [h264]
  // Main profile at level 5.1. Not every browser encodes HEVC; H.264 then takes its place.
  const hevc = { label: 'HEVC', config: { ...base, codec: 'hvc1.1.6.L153.B0', hevc: { format: 'hevc' } } as VideoEncoderConfig }
  return [hevc, h264]
}

/**
 * Exports in the browser what the desktop app exports through FFmpeg: the
 * frames drawn by `renderExport` go to a `VideoEncoder`, the sound is mixed
 * in memory and goes to an `AudioEncoder`, and `mp4-muxer` writes the MP4 —
 * straight to the file the user chose where the browser allows, or as a
 * download when it does not. Nothing leaves the browser.
 */
export class WebExporter {
  private active: ActiveExport | null = null

  async start(sessionId: string, overrides: ExportOverrides | null): Promise<ExportJob> {
    if (this.active) throw new WebExportError(appError('export-busy'))
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      throw new WebExportError(appError('export-failed', 'Este navegador não tem WebCodecs. Use o Chrome, o Edge ou o Safari 16.4 ou mais recente.'))
    }
    const video = webSessions.get(sessionId)
    const saved = video?.project
    if (!video || !saved) throw new WebExportError(appError('invalid-state', 'no project open'))
    const project: Project = overrides
      ? { ...saved, export: overrides.export, background: { ...saved.background, aspect: overrides.aspect } }
      : saved
    if (needsRenderedTrack(project.filters)) throw new WebExportError(appError('web-unsupported', 'rendered effects'))

    const map = buildTimeMap(video.durationMs, project.effects)
    const plan = createExportPlan({ width: video.widthPx, height: video.heightPx }, map, project.export, project.background.aspect)
    const fileName = suggestedFileName(video.title, video.createdAt, plan.speed, project.export.preset)

    // Where it goes: asked first, as the desktop asks, so a cancelled dialog costs nothing.
    const handle = await chooseSaveFile(fileName, MP4_KIND, 'Vídeo MP4')
    if (handle === null) throw new WebExportError(appError('export-cancelled'))

    const blobs = new Map<ExportTrackName, Blob>()
    const screen = await this.describeTrack(video.file, video)
    blobs.set('screen', video.file)
    const clips: ExportJob['clips'] = []
    for (const file of new Set(project.layers.filter((layer) => layer.kind === 'video').map((layer) => layer.file))) {
      const asset = video.assets.get(file)
      if (!asset || asset.kind !== 'clip') continue
      clips.push({ file, track: await this.describeTrack(asset.blob, asset) })
      blobs.set(clipTrackName(file), asset.blob)
    }

    // The encoder: the plan's codec when the browser has it, H.264 otherwise.
    let chosen: { label: string; config: VideoEncoderConfig } | null = null
    for (const candidate of videoConfigs(plan)) {
      const support = await VideoEncoder.isConfigSupported(candidate.config).catch(() => null)
      if (support?.supported) {
        chosen = candidate
        break
      }
    }
    if (!chosen) throw new WebExportError(appError('export-failed', 'Este navegador não codifica vídeo H.264.'))

    const musicAsset = [...video.assets.values()].find((asset) => asset.kind === 'music')
    const hasAudio = (video.hasAudio && !project.audio.microphone.muted) || (project.music !== null && project.music.volume > 0 && musicAsset !== undefined)
    const withAudio = hasAudio && typeof AudioEncoder !== 'undefined'
    const writable = handle ? await handle.createWritable() : null
    const target: Target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget()
    const muxer = new Muxer<Target>({
      target,
      video: { codec: chosen.config.codec.startsWith('hvc1') ? 'hevc' : 'avc', width: plan.width, height: plan.height, frameRate: plan.fps },
      ...(withAudio ? { audio: { codec: 'aac' as const, sampleRate: EXPORT_CONFIG.audioSampleRate, numberOfChannels: 2 } } : {}),
      fastStart: writable ? false : 'in-memory',
      firstTimestampBehavior: 'offset'
    })

    const id = crypto.randomUUID()
    const active: ActiveExport = {
      id,
      video,
      plan,
      fileName: handle?.name ?? fileName,
      muxer,
      target,
      handle: handle ?? null,
      writable,
      encoder: new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (error) => {
          active.failure = error
        }
      }),
      frameIndex: 0,
      failure: null,
      audio: null,
      blobs
    }
    active.encoder.configure(chosen.config)
    if (withAudio) active.audio = this.renderAudio(active, project, map)
    this.active = active
    return { exportId: id, plan, encoder: `${chosen.label} (navegador)`, fileName: active.fileName, screen, webcam: null, clips }
  }

  async readChunk(exportId: string, track: ExportTrackName, offset: number, length: number): Promise<Uint8Array> {
    const active = this.require(exportId)
    const blob = active.blobs.get(track)
    if (!blob) throw new WebExportError(appError('export-failed', `no track ${track}`))
    return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
  }

  async writeFrame(exportId: string, pixels: Uint8Array): Promise<void> {
    const active = this.require(exportId)
    if (active.failure) throw new WebExportError(appError('export-failed', String(active.failure)))
    const { plan, encoder } = active
    const frameUs = 1_000_000 / plan.fps
    const frame = new VideoFrame(pixels, {
      format: 'RGBA',
      codedWidth: plan.width,
      codedHeight: plan.height,
      timestamp: Math.round(active.frameIndex * frameUs),
      duration: Math.round(frameUs)
    })
    try {
      encoder.encode(frame, { keyFrame: active.frameIndex % Math.round(plan.fps * KEYFRAME_INTERVAL_SEC) === 0 })
    } finally {
      frame.close()
    }
    active.frameIndex += 1
    // Awaiting the encoder is the back-pressure: the renderer draws no faster than it encodes.
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE && !active.failure) {
      await new Promise<void>((resolve) => encoder.addEventListener('dequeue', () => resolve(), { once: true }))
    }
  }

  async finish(exportId: string): Promise<ExportResult> {
    const active = this.require(exportId)
    try {
      await active.encoder.flush()
      if (active.failure) throw active.failure
      const audio = active.audio ? await active.audio : { kind: 'none' as const }
      if (audio.kind === 'failed') throw new Error(audio.reason)
      active.muxer.finalize()
      let sizeBytes: number
      if (active.writable) {
        await active.writable.close()
        sizeBytes = active.handle ? (await active.handle.getFile()).size : 0
      } else {
        const { buffer } = active.target as ArrayBufferTarget
        sizeBytes = buffer.byteLength
        downloadBlob(new Blob([buffer], { type: 'video/mp4' }), active.fileName)
      }
      return { exportId, fileName: active.fileName, sizeBytes }
    } catch (error) {
      await this.abort(active)
      throw error instanceof WebExportError ? error : new WebExportError(appError('export-failed', String(error)))
    } finally {
      this.release(active)
    }
  }

  async cancel(exportId?: string): Promise<void> {
    const active = this.active
    if (!active || (exportId && active.id !== exportId)) return
    await this.abort(active)
    this.release(active)
  }

  private async abort(active: ActiveExport): Promise<void> {
    if (active.encoder.state !== 'closed') active.encoder.close()
    if (active.writable) await active.writable.abort().catch(() => undefined)
  }

  private release(active: ActiveExport): void {
    if (this.active === active) this.active = null
  }

  private require(exportId: string): ActiveExport {
    const active = this.active
    if (!active || active.id !== exportId) throw new WebExportError(appError('invalid-state', 'no such export'))
    return active
  }

  private async describeTrack(blob: Blob, dimensions: { widthPx: number; heightPx: number }): Promise<ExportTrack> {
    let description
    try {
      description = await describeMp4(blobSource(blob))
    } catch (error) {
      throw new WebExportError(appError('export-failed', String(error)))
    }
    const video = description.video
    if (!video || video.sizes.length === 0 || !video.keyframes[0]) {
      throw new WebExportError(appError('export-failed', 'track has no decodable frames'))
    }
    return {
      codec: video.codec,
      description: video.description,
      widthPx: dimensions.widthPx || video.widthPx,
      heightPx: dimensions.heightPx || video.heightPx,
      fileSizeBytes: blob.size,
      timestampsUs: video.timestampsUs,
      offsets: video.offsets,
      sizes: video.sizes,
      keyframes: video.keyframes
    }
  }

  /** Decodes the sound, mixes it as the edit asks, and hands it to the muxer as AAC. */
  private async renderAudio(active: ActiveExport, project: Project, map: MixdownInput['map']): Promise<AudioOutcome> {
    const sampleRate = EXPORT_CONFIG.audioSampleRate
    try {
      const decode = async (blob: Blob): Promise<Float32Array[]> => {
        const context = new OfflineAudioContext(2, 1, sampleRate)
        const buffer = await context.decodeAudioData(await blob.arrayBuffer())
        return Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
      }
      const tracks: MixdownTrack[] = []
      if (active.video.hasAudio && !project.audio.microphone.muted) {
        tracks.push({ channels: await decode(active.video.file), sampleRate, volume: project.audio.microphone.volume })
      }
      const musicAsset = [...active.video.assets.values()].find((asset) => asset.kind === 'music')
      const music: MixdownInput['music'] =
        project.music && musicAsset && project.music.volume > 0
          ? { channels: await decode(musicAsset.blob), sampleRate, settings: project.music }
          : null
      const mixed = mixdown({
        tracks,
        music,
        map,
        exportSpeed: active.plan.speed,
        loudness: project.export.loudness,
        outputDurationMs: active.plan.outputDurationMs,
        sampleRate
      })

      let failure: Error | null = null
      const encoder = new AudioEncoder({
        output: (chunk, meta) => active.muxer.addAudioChunk(chunk, meta),
        error: (error) => {
          failure = error
        }
      })
      const config: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: active.plan.audioBitrate }
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null)
      if (!support?.supported) return { kind: 'failed', reason: 'Este navegador não codifica áudio AAC.' }
      encoder.configure(config)
      const total = mixed[0].length
      for (let start = 0; start < total; start += AUDIO_CHUNK_FRAMES) {
        const frames = Math.min(AUDIO_CHUNK_FRAMES, total - start)
        const planar = new Float32Array(frames * 2)
        planar.set(mixed[0].subarray(start, start + frames), 0)
        planar.set(mixed[1].subarray(start, start + frames), frames)
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frames,
          numberOfChannels: 2,
          timestamp: Math.round((start / sampleRate) * 1_000_000),
          data: planar
        })
        encoder.encode(data)
        data.close()
        if (failure) break
      }
      await encoder.flush()
      encoder.close()
      if (failure) return { kind: 'failed', reason: String(failure) }
      return { kind: 'done', samples: total }
    } catch (error) {
      return { kind: 'failed', reason: String(error) }
    }
  }
}
