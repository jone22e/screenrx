import type { ExportPlan } from '@engine/export/exportPlan'
import type { ExportSettings, FrameAspect } from './project'
import { isFrameAspect, parseExportSettings } from './project'

/**
 * A video track as the exporter reads it: where each encoded frame sits in
 * the file and when it is shown, plus what a decoder needs to be configured.
 * Samples are in decode order, which for these recordings is display order.
 */
export interface ExportTrack {
  /** WebCodecs codec string, e.g. `avc1.640033`. */
  codec: string
  /** Decoder configuration record (the MP4 `avcC` payload). */
  description: Uint8Array
  widthPx: number
  heightPx: number
  fileSizeBytes: number
  /** Parallel arrays, one entry per frame. */
  timestampsUs: number[]
  offsets: number[]
  sizes: number[]
  keyframes: boolean[]
}

/** The screen, the webcam, or a b-roll clip by its file name in `assets/` (`clip:<file>`). */
export type ExportTrackName = 'screen' | 'webcam' | `clip:${string}`

export function isExportTrackName(value: unknown): value is ExportTrackName {
  if (value === 'screen' || value === 'webcam') return true
  return typeof value === 'string' && value.startsWith('clip:') && value.length <= 300 && !/[/\\\0]/.test(value.slice(5))
}

export const clipTrackName = (file: string): ExportTrackName => `clip:${file}`

/** An export in progress, as handed to the renderer that draws its frames. */
export interface ExportJob {
  exportId: string
  plan: ExportPlan
  /** Encoder FFmpeg is using, for display. */
  encoder: string
  fileName: string
  screen: ExportTrack
  webcam: ExportTrack | null
  /** The b-roll clips the layers show, by file name. */
  clips: Array<{ file: string; track: ExportTrack }>
}

export interface ExportResult {
  exportId: string
  fileName: string
  sizeBytes: number
}

/**
 * Settings an export runs with in place of the project's — how a batch
 * exports one file per platform without touching the project.
 */
export interface ExportOverrides {
  export: ExportSettings
  aspect: FrameAspect
}

export function parseExportOverrides(value: unknown): ExportOverrides | null {
  if (typeof value !== 'object' || value === null) return null
  const { export: settings, aspect } = value as Record<string, unknown>
  if (!isFrameAspect(aspect)) return null
  return { export: parseExportSettings(settings), aspect }
}
