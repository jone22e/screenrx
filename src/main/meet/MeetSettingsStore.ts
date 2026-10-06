import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { MeetSettings } from '@shared/models/meet'
import { EMPTY_MEET_SETTINGS, parseMeetSettings } from '@shared/models/meet'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'

const FILE_NAME = 'meet-settings.json'

/**
 * Where the meeting app is and the recorder token, kept by the main process
 * (the renderer never holds the token) in the app's own data directory.
 */
export class MeetSettingsStore {
  private settings: MeetSettings | null = null

  constructor(
    private readonly directory: string,
    private readonly logger: Logger
  ) {}

  async get(): Promise<MeetSettings> {
    if (this.settings) return this.settings
    try {
      const raw = await readFile(path.join(this.directory, FILE_NAME), 'utf8')
      this.settings = parseMeetSettings(JSON.parse(raw))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.logger.warn('could not read meet settings', { error: String(error) })
      this.settings = EMPTY_MEET_SETTINGS
    }
    return this.settings
  }

  async save(value: unknown): Promise<MeetSettings> {
    const settings = parseMeetSettings(value)
    await writeJsonAtomic(path.join(this.directory, FILE_NAME), settings)
    this.settings = settings
    return settings
  }
}
