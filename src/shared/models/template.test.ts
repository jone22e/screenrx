import { describe, expect, it } from 'vitest'
import { DEFAULT_MUSIC, createProject } from './project'
import { applyTemplateTo, parseTemplates, templateFromProject } from './template'

const sessionId = 'recording-20261116-100000-000'

describe('project templates', () => {
  const project = {
    ...createProject(sessionId),
    background: { ...createProject(sessionId).background, aspect: '9:16' as const, presetId: 'ocean' },
    music: { ...DEFAULT_MUSIC, volume: 0.4 },
    export: { ...createProject(sessionId).export, speed: 1.5, preset: 'reels' as const }
  }

  it('takes the look and the settings, not what belongs to one recording', () => {
    const template = templateFromProject(project, '  Reels   padrão ', 'tpl-1', '2026-11-16T10:00:00.000Z')
    expect(template.name).toBe('Reels padrão')
    expect(template.background.aspect).toBe('9:16')
    expect(template.music?.volume).toBe(0.4)
    expect(template.export).toMatchObject({ preset: 'reels', speed: 1 })
    expect(template).not.toHaveProperty('effects')
    expect(template).not.toHaveProperty('layers')
  })

  it('applies to another project, keeping its cues, its music file and its speed', () => {
    const template = templateFromProject(project, 'Reels', 'tpl-1', '2026-11-16T10:00:00.000Z')
    const other = { ...createProject('recording-20261116-110000-000'), export: { ...createProject(sessionId).export, speed: 2 } }
    const applied = applyTemplateTo(other, template)
    expect(applied.background.aspect).toBe('9:16')
    expect(applied.export).toMatchObject({ preset: 'reels', speed: 2 })
    // No music in the other project: the template's music settings wait for a file.
    expect(applied.music).toBeNull()
    expect(applied.captions.cues).toEqual(other.captions.cues)
    expect(applyTemplateTo({ ...other, music: DEFAULT_MUSIC }, template).music?.volume).toBe(0.4)
  })

  it('reads saved templates back and repairs or drops the broken ones', () => {
    const template = templateFromProject(project, 'Reels', 'tpl-1', '2026-11-16T10:00:00.000Z')
    const saved = [template, { id: 'tpl-2', name: 'Quebrado', background: { aspect: 'round' }, export: { fps: 999 } }, { name: 'sem id' }, 'lixo']
    const parsed = parseTemplates(JSON.parse(JSON.stringify(saved)))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual(template)
    expect(parsed[1]).toMatchObject({ id: 'tpl-2', name: 'Quebrado' })
    expect(parsed[1]?.background.aspect).toBe('native')
    expect(parsed[1]?.export.fps).toBe(30)
  })
})
