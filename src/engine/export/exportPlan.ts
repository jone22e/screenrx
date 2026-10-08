import type { ExportSettings, FrameAspect } from '@shared/models/project'
import type { Size } from '../rendering/frameLayout'
import { outputSizeFor } from '../rendering/frameLayout'
import type { TimeMap } from '../time/timeMapping'
import { outputDurationMs, outputTimeToSourceTime } from '../time/timeMapping'
import { EXPORT_CONFIG } from './exportConfig'

export type ExportCodec = 'h264' | 'hevc'

/** The shape of the file an export will produce. */
export interface ExportPlan {
  width: number
  height: number
  fps: number
  /** H.264 at the lower compression levels, HEVC at the higher ones. */
  codec: ExportCodec
  audioBitrate: number
  frameCount: number
  /** Global playback speed applied on top of the edited timeline. */
  speed: number
  outputDurationMs: number
  videoBitrate: number
}

/**
 * Even dimensions (required by 4:2:0), with the longer side within the
 * quality's limit, never upscaled. The limit is on the longer side so a
 * vertical video is capped as a horizontal one of the same size would be.
 */
function outputSize(source: Size, aspect: FrameAspect, quality: ExportSettings['quality']): Size {
  const shaped = outputSizeFor(source, aspect)
  const scale = Math.min(1, EXPORT_CONFIG.maxWidthPx[quality] / Math.max(shaped.width, shaped.height))
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
  return { width: even(shaped.width * scale), height: even(shaped.height * scale) }
}

export function createExportPlan(
  source: Size,
  map: TimeMap,
  settings: ExportSettings,
  aspect: FrameAspect = 'native'
): ExportPlan {
  const { width, height } = outputSize(source, aspect, settings.quality)
  const durationMs = outputDurationMs(map, settings.speed)
  const { fps } = settings
  const level = EXPORT_CONFIG.compressionLevels[settings.compression] ?? EXPORT_CONFIG.compressionLevels[0]!
  // More frames per second need proportionally more bits to look the same; HEVC needs fewer of them.
  const share = level.bitrateShare
  const bitrate = width * height * fps * EXPORT_CONFIG.bitsPerPixelPerFrame * share
  return {
    width,
    height,
    fps,
    codec: level.codec,
    audioBitrate: level.audioBitrate,
    frameCount: Math.max(1, Math.round((durationMs / 1000) * fps)),
    speed: settings.speed,
    outputDurationMs: durationMs,
    videoBitrate: Math.round(
      Math.min(Math.max(bitrate, EXPORT_CONFIG.minVideoBitrate * share), EXPORT_CONFIG.maxVideoBitrate * share)
    )
  }
}

/** About how many bytes the file will take: the bitrates over the duration, plus the container. */
export function estimatedFileBytes(plan: ExportPlan, withAudio: boolean): number {
  const seconds = plan.outputDurationMs / 1000
  return Math.round(((plan.videoBitrate + (withAudio ? plan.audioBitrate : 0)) / 8) * seconds * 1.02)
}

/**
 * The instant of the recording shown by output frame `frameIndex`:
 * output time → timeline time (× export speed) → source time (cuts, speed regions).
 * The frame is rendered once, directly at its final position — a sped-up
 * export is never a 1x render encoded twice.
 */
export function frameSourceTimeMs(plan: ExportPlan, map: TimeMap, frameIndex: number): number {
  return outputTimeToSourceTime(map, (frameIndex / plan.fps) * 1000, plan.speed)
}
