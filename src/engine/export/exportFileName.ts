import type { ExportPreset } from '@shared/models/project'

const PRESET_SUFFIXES: Record<Exclude<ExportPreset, 'custom'>, string> = {
  reels: 'Reels',
  tiktok: 'TikTok',
  shorts: 'Shorts',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X'
}

/** `Display 1 2026-10-03 21.29 2x Reels.mp4`, safe on every file system. */
export function suggestedFileName(title: string, createdAt: string, speed: number, preset: ExportPreset = 'custom'): string {
  const date = new Date(createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = Number.isNaN(date.getTime())
    ? ''
    : ` ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`
  const printable = [...title].filter((character) => character.charCodeAt(0) >= 32).join('')
  const safeTitle = printable.replace(/[/\\:*?"<>|]/g, '-').trim().slice(0, 80) || 'Gravação'
  const suffix = speed === 1 ? '' : ` ${String(speed).replace('.', ',')}x`
  const platform = preset === 'custom' ? '' : ` ${PRESET_SUFFIXES[preset]}`
  return `${safeTitle}${stamp}${suffix}${platform}.mp4`
}
