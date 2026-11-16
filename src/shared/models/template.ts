import type { BackgroundSettings, CaptionSettings, CursorSettings, ExportSettings, MusicSettings, Project, WebcamSettings } from './project'
import { createProject, parseProject } from './project'

/**
 * A project template: the look and the settings of an edit, saved to apply
 * to the next recording — background and shape, caption style, cursor,
 * webcam, music settings, export settings. Nothing tied to one recording
 * (cuts, zooms, cues, texts, layers, markers) is part of it.
 */
export interface ProjectTemplate {
  id: string
  name: string
  createdAt: string
  background: BackgroundSettings
  captions: Pick<CaptionSettings, 'visible' | 'length' | 'style'>
  cursor: CursorSettings
  webcam: WebcamSettings
  /** How music plays, when the template was saved with music; the file itself is not saved. */
  music: MusicSettings | null
  export: ExportSettings
}

export const TEMPLATE_LIMITS = { maxTemplates: 50, maxNameLength: 60 } as const

/** The template a project would make, named `name`. */
export function templateFromProject(project: Project, name: string, id: string, createdAt: string): ProjectTemplate {
  return {
    id,
    name: name.replace(/\s+/g, ' ').trim().slice(0, TEMPLATE_LIMITS.maxNameLength) || 'Modelo',
    createdAt,
    background: { ...project.background, crop: { ...project.background.crop } },
    captions: { visible: project.captions.visible, length: project.captions.length, style: { ...project.captions.style, position: { ...project.captions.style.position } } },
    cursor: { ...project.cursor },
    webcam: { ...project.webcam, position: { ...project.webcam.position } },
    music: project.music ? { ...project.music } : null,
    export: { ...project.export, speed: 1 }
  }
}

/**
 * The project with the template's look and settings over it. Captions keep
 * their cues and language; music settings apply only when the project has
 * music; the export speed is the project's own.
 */
export function applyTemplateTo(project: Project, template: ProjectTemplate): Project {
  return {
    ...project,
    background: { ...template.background, crop: { ...template.background.crop } },
    captions: { ...project.captions, visible: template.captions.visible, length: template.captions.length, style: { ...template.captions.style, position: { ...template.captions.style.position } } },
    cursor: { ...template.cursor },
    webcam: { ...template.webcam, position: { ...template.webcam.position } },
    music: project.music && template.music ? { ...template.music } : project.music,
    export: { ...template.export, speed: project.export.speed }
  }
}

/** Templates as saved; a malformed one is dropped, and each field is repaired as a project's would be. */
export function parseTemplates(value: unknown): ProjectTemplate[] {
  if (!Array.isArray(value)) return []
  const templates: ProjectTemplate[] = []
  for (const entry of value.slice(0, TEMPLATE_LIMITS.maxTemplates)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '' || typeof record.name !== 'string') continue
    // The fields are checked by the project parser, on a project built from them.
    const base = createProject('template')
    const parsed = parseProject(
      {
        ...base,
        background: record.background,
        captions: { ...base.captions, ...(typeof record.captions === 'object' && record.captions !== null ? record.captions : {}), cues: [] },
        cursor: record.cursor,
        webcam: record.webcam,
        music: record.music ?? null,
        export: record.export
      },
      'template'
    )
    if (!parsed) continue
    templates.push(templateFromProject(parsed, record.name, record.id, typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString()))
  }
  return templates
}
