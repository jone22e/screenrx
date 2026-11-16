import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectTemplate } from '@shared/models/template'
import { TEMPLATE_LIMITS, parseTemplates } from '@shared/models/template'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'

const FILE_NAME = 'templates.json'

/** The user's project templates, kept in the app's own data directory, newest first. */
export class TemplateStore {
  private templates: ProjectTemplate[] | null = null

  constructor(
    private readonly directory: string,
    private readonly logger: Logger
  ) {}

  async list(): Promise<ProjectTemplate[]> {
    if (this.templates) return this.templates
    try {
      this.templates = parseTemplates(JSON.parse(await readFile(path.join(this.directory, FILE_NAME), 'utf8')))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.logger.warn('could not read templates', { error: String(error) })
      this.templates = []
    }
    return this.templates
  }

  /** Adds a template (or replaces the one with the same id) and returns the list. */
  async save(value: unknown): Promise<ProjectTemplate[]> {
    const [template] = parseTemplates([value])
    if (!template) throw new Error('invalid template')
    const others = (await this.list()).filter((candidate) => candidate.id !== template.id)
    const templates = [template, ...others].slice(0, TEMPLATE_LIMITS.maxTemplates)
    await writeJsonAtomic(path.join(this.directory, FILE_NAME), templates)
    this.templates = templates
    return templates
  }

  async delete(id: string): Promise<ProjectTemplate[]> {
    const templates = (await this.list()).filter((candidate) => candidate.id !== id)
    await writeJsonAtomic(path.join(this.directory, FILE_NAME), templates)
    this.templates = templates
    return templates
  }
}
