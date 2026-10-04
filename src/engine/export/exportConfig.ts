import type { ExportSettings } from '@shared/models/project'

/** Every tunable of the export, in one place. */
export const EXPORT_CONFIG = {
  fps: 30,
  /** Widest output per quality; narrower recordings are never upscaled. */
  maxWidthPx: { standard: 1920, high: 2560 } satisfies Record<ExportSettings['quality'], number>,
  bitsPerPixelPerFrame: 0.14,
  minVideoBitrate: 4_000_000,
  maxVideoBitrate: 40_000_000,
  audioBitrate: 192_000,
  audioSampleRate: 48_000,
  /** Global playback speeds offered for the exported file. */
  speeds: [0.5, 1, 1.25, 1.5, 2, 3],
  /** Range a single `atempo` filter is trusted with; other speeds are chained. */
  atempoRange: { min: 0.5, max: 2 }
} as const

export function isExportSpeed(value: unknown): value is number {
  return typeof value === 'number' && (EXPORT_CONFIG.speeds as readonly number[]).includes(value)
}
