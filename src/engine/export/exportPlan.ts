import type { ExportSettings } from '@shared/models/project'
import type { Size } from '../rendering/frameLayout'
import type { TimeMap } from '../time/timeMapping'
import { outputDurationMs, outputTimeToSourceTime } from '../time/timeMapping'
import { EXPORT_CONFIG } from './exportConfig'

/** The shape of the file an export will produce. */
export interface ExportPlan {
  width: number
  height: number
  fps: number
  frameCount: number
  /** Global playback speed applied on top of the edited timeline. */
  speed: number
  outputDurationMs: number
  videoBitrate: number
}

/** Even dimensions (required by 4:2:0), within the quality's width, never upscaled. */
function outputSize(source: Size, quality: ExportSettings['quality']): Size {
  const scale = Math.min(1, EXPORT_CONFIG.maxWidthPx[quality] / source.width)
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
  return { width: even(source.width * scale), height: even(source.height * scale) }
}

export function createExportPlan(source: Size, map: TimeMap, settings: ExportSettings): ExportPlan {
  const { width, height } = outputSize(source, settings.quality)
  const durationMs = outputDurationMs(map, settings.speed)
  const { fps } = settings
  // More frames per second need proportionally more bits to look the same.
  const bitrate = width * height * fps * EXPORT_CONFIG.bitsPerPixelPerFrame
  return {
    width,
    height,
    fps,
    frameCount: Math.max(1, Math.round((durationMs / 1000) * fps)),
    speed: settings.speed,
    outputDurationMs: durationMs,
    videoBitrate: Math.round(
      Math.min(Math.max(bitrate, EXPORT_CONFIG.minVideoBitrate), EXPORT_CONFIG.maxVideoBitrate)
    )
  }
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
