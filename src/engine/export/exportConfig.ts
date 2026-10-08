import type { ExportSettings } from '@shared/models/project'

/** Every tunable of the export, in one place. */
export const EXPORT_CONFIG = {
  /** Widest output per quality; narrower recordings are never upscaled. */
  maxWidthPx: { standard: 1920, high: 2560 } satisfies Record<ExportSettings['quality'], number>,
  bitsPerPixelPerFrame: 0.14,
  minVideoBitrate: 4_000_000,
  maxVideoBitrate: 40_000_000,
  audioBitrate: 192_000,
  /**
   * The compression levels, by `ExportSettings.compression`: the codec, the
   * share of the full H.264 bitrate, and the audio bitrate. HEVC keeps the
   * same sharpness with about half the bits; screen recordings, mostly still,
   * stay sharp well below that.
   */
  compressionLevels: [
    { codec: 'h264', bitrateShare: 1, audioBitrate: 192_000 },
    { codec: 'h264', bitrateShare: 0.72, audioBitrate: 160_000 },
    { codec: 'hevc', bitrateShare: 0.55, audioBitrate: 128_000 },
    { codec: 'hevc', bitrateShare: 0.4, audioBitrate: 128_000 },
    { codec: 'hevc', bitrateShare: 0.3, audioBitrate: 96_000 }
  ] as ReadonlyArray<{ codec: 'h264' | 'hevc'; bitrateShare: number; audioBitrate: number }>,
  audioSampleRate: 48_000,
  /** Global playback speeds offered for the exported file. */
  speeds: [0.5, 1, 1.25, 1.5, 2, 3],
  /** Range a single `atempo` filter is trusted with; other speeds are chained. */
  atempoRange: { min: 0.5, max: 2 }
} as const

export function isExportSpeed(value: unknown): value is number {
  return typeof value === 'number' && (EXPORT_CONFIG.speeds as readonly number[]).includes(value)
}
