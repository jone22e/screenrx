import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS, EXPORT_PRESETS } from '@shared/models/project'
import { buildTimeMap } from '../time/timeMapping'
import { createExportPlan, estimatedFileBytes } from './exportPlan'
import { PLATFORM_PRESETS, applyPlatformPreset, platformPreset, presetWarnings } from './platformPresets'

describe('platform presets', () => {
  it('has one entry per preset but custom', () => {
    expect(PLATFORM_PRESETS.map((preset) => preset.id)).toEqual(EXPORT_PRESETS.filter((id) => id !== 'custom'))
    expect(platformPreset('custom')).toBeNull()
    expect(platformPreset('reels')?.aspect).toBe('9:16')
  })

  it('applies resolution, codec and frame rate, keeping the speed and loudness as set', () => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS, speed: 1.5, loudness: 'off' as const, fps: 60 as const }
    const reels = applyPlatformPreset(settings, platformPreset('reels')!)
    expect(reels).toMatchObject({ preset: 'reels', quality: 'standard', compression: 1, fps: 30, speed: 1.5, loudness: 'off' })
    expect(applyPlatformPreset(settings, platformPreset('youtube')!)).toMatchObject({ preset: 'youtube', quality: 'high', compression: 0, fps: 60 })
  })
})

describe('presetWarnings', () => {
  const source = { width: 1920, height: 1080 }

  it('warns about a video longer than the platform takes, and about the wrong shape', () => {
    const reels = platformPreset('reels')!
    const map = buildTimeMap(4 * 60_000, [])
    const settings = applyPlatformPreset(DEFAULT_EXPORT_SETTINGS, reels)
    const plan = createExportPlan(source, map, settings, 'native')
    const warnings = presetWarnings(reels, plan, estimatedFileBytes(plan, true), 'native')
    expect(warnings.map((warning) => warning.kind)).toEqual(['duration', 'aspect'])
    expect(warnings[0]?.message).toBe('Reels aceita até 3 min; o vídeo tem 4 min.')
    expect(warnings[1]?.message).toContain('vertical (9:16)')
  })

  it('warns about a file too big for the platform', () => {
    const x = platformPreset('x')!
    // 2 min 20 s (just what X takes) of 1440p60 at the full H.264 bitrate: about 550 MB, over 512 MB.
    const plan = createExportPlan({ width: 3840, height: 2160 }, buildTimeMap(140_000, []), { ...DEFAULT_EXPORT_SETTINGS, quality: 'high', compression: 0, fps: 60 }, 'native')
    const warnings = presetWarnings(x, plan, estimatedFileBytes(plan, true), 'native')
    expect(warnings.map((warning) => warning.kind)).toEqual(['size'])
    expect(warnings[0]?.message).toContain('512 MB')
  })

  it('says nothing for a file the platform takes', () => {
    const tiktok = platformPreset('tiktok')!
    const plan = createExportPlan(source, buildTimeMap(30_000, []), applyPlatformPreset(DEFAULT_EXPORT_SETTINGS, tiktok), '9:16')
    expect(presetWarnings(tiktok, plan, estimatedFileBytes(plan, true), '9:16')).toEqual([])
    const linkedin = platformPreset('linkedin')!
    expect(presetWarnings(linkedin, plan, estimatedFileBytes(plan, true), 'native')).toEqual([])
  })
})
