import type { ExportPlan } from '@engine/export/exportPlan'

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

export type ExportTrackName = 'screen' | 'webcam'

export function isExportTrackName(value: unknown): value is ExportTrackName {
  return value === 'screen' || value === 'webcam'
}

/** An export in progress, as handed to the renderer that draws its frames. */
export interface ExportJob {
  exportId: string
  plan: ExportPlan
  /** Encoder FFmpeg is using, for display. */
  encoder: string
  fileName: string
  screen: ExportTrack
  webcam: ExportTrack | null
}

export interface ExportResult {
  exportId: string
  fileName: string
  sizeBytes: number
}
