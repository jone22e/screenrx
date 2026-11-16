import type { ExportCompression, ExportFps, ExportPreset, ExportSettings, FrameAspect } from '@shared/models/project'
import type { ExportPlan } from './exportPlan'

/**
 * What a platform wants and what it refuses, as published by each in 2026.
 * The settings are what the preset applies; the limits are what the export
 * dialog warns about. None of it is enforced: a longer video still exports,
 * and the platform decides.
 */
export interface PlatformPreset {
  id: Exclude<ExportPreset, 'custom'>
  label: string
  /** The shape the platform plays best; `null` for one that takes any. */
  aspect: FrameAspect | null
  quality: ExportSettings['quality']
  compression: ExportCompression
  fps: ExportFps
  /** Longest video the platform accepts; `null` when it hardly matters. */
  maxDurationMs: number | null
  maxFileBytes: number | null
  hint: string
}

const MINUTE = 60_000
const GB = 1024 ** 3
const MB = 1024 ** 2

export const PLATFORM_PRESETS: readonly PlatformPreset[] = [
  {
    id: 'reels',
    label: 'Reels',
    aspect: '9:16',
    quality: 'standard',
    compression: 1,
    fps: 30,
    maxDurationMs: 3 * MINUTE,
    maxFileBytes: 4 * GB,
    hint: 'Instagram: vertical 9:16, 1080×1920, H.264, 30 fps, até 3 minutos.'
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    aspect: '9:16',
    quality: 'standard',
    compression: 1,
    fps: 30,
    maxDurationMs: 10 * MINUTE,
    maxFileBytes: 4 * GB,
    hint: 'Vertical 9:16, 1080×1920, H.264, 30 fps, até 10 minutos.'
  },
  {
    id: 'shorts',
    label: 'Shorts',
    aspect: '9:16',
    quality: 'standard',
    compression: 1,
    fps: 30,
    maxDurationMs: 3 * MINUTE,
    maxFileBytes: null,
    hint: 'YouTube Shorts: vertical 9:16, 1080×1920, até 3 minutos. Mais longo vira um vídeo comum.'
  },
  {
    id: 'youtube',
    label: 'YouTube',
    aspect: 'native',
    quality: 'high',
    compression: 0,
    fps: 60,
    maxDurationMs: null,
    maxFileBytes: null,
    hint: 'Vídeo comum: o formato da gravação, na maior resolução, H.264, 60 fps. O YouTube recomprime, então vai no melhor.'
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    aspect: null,
    quality: 'standard',
    compression: 1,
    fps: 30,
    maxDurationMs: 10 * MINUTE,
    maxFileBytes: 5 * GB,
    hint: 'Horizontal, quadrado ou vertical; 1080p, H.264, 30 fps, até 10 minutos.'
  },
  {
    id: 'x',
    label: 'X',
    aspect: null,
    quality: 'standard',
    compression: 1,
    fps: 30,
    maxDurationMs: 140_000,
    maxFileBytes: 512 * MB,
    hint: 'Até 2 min 20 s e 512 MB; 1080p, H.264, 30 fps. Horizontal ou quadrado passa melhor.'
  }
]

export function platformPreset(id: ExportPreset): PlatformPreset | null {
  return PLATFORM_PRESETS.find((preset) => preset.id === id) ?? null
}

/** The export settings a preset asks for, over what the user has (speed and loudness are theirs). */
export function applyPlatformPreset(settings: ExportSettings, preset: PlatformPreset): ExportSettings {
  return { ...settings, preset: preset.id, quality: preset.quality, compression: preset.compression, fps: preset.fps }
}

/** Something about the planned file the platform will not like. */
export interface PresetWarning {
  kind: 'duration' | 'size' | 'aspect'
  message: string
}

const clock = (ms: number): string => {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes === 0 ? `${seconds} s` : seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

const bytes = (value: number): string => (value >= GB ? `${Math.round(value / GB)} GB` : `${Math.round(value / MB)} MB`)

/**
 * What the platform will refuse or play badly, for the file as planned.
 * Nothing stops the export; the user decides.
 */
export function presetWarnings(
  preset: PlatformPreset,
  plan: ExportPlan,
  estimatedBytes: number,
  aspect: FrameAspect
): PresetWarning[] {
  const warnings: PresetWarning[] = []
  if (preset.maxDurationMs !== null && plan.outputDurationMs > preset.maxDurationMs) {
    warnings.push({
      kind: 'duration',
      message: `${preset.label} aceita até ${clock(preset.maxDurationMs)}; o vídeo tem ${clock(plan.outputDurationMs)}.`
    })
  }
  if (preset.maxFileBytes !== null && estimatedBytes > preset.maxFileBytes) {
    warnings.push({
      kind: 'size',
      message: `${preset.label} aceita arquivos até ${bytes(preset.maxFileBytes)}; este deve ficar em ${bytes(estimatedBytes)}. Aumente a compactação.`
    })
  }
  if (preset.aspect !== null && preset.aspect !== aspect) {
    warnings.push({
      kind: 'aspect',
      message:
        preset.aspect === '9:16'
          ? `${preset.label} é vertical (9:16); o vídeo está em outro formato. Mude em Formato.`
          : `${preset.label} espera o formato da gravação; o vídeo está recortado. Mude em Formato.`
    })
  }
  return warnings
}
