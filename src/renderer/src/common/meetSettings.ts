import { useSyncExternalStore } from 'react'
import type { MeetSettings } from '@shared/models/meet'
import { EMPTY_MEET_SETTINGS, isMeetConfigured } from '@shared/models/meet'

export interface MeetSettingsState {
  /** As kept by the main process; `null` until first read. */
  settings: MeetSettings | null
  saving: boolean
  failure: string | null
}

/**
 * The meeting app's address and recorder token. They live with the main
 * process (which makes the calls); this store mirrors them for the settings
 * screen and tells the library whether meetings can be listed at all.
 */
class MeetSettingsStore {
  private state: MeetSettingsState = { settings: null, saving: false, failure: null }
  private readonly listeners = new Set<() => void>()
  private loading: Promise<void> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): MeetSettingsState => this.state

  load(): Promise<void> {
    if (this.state.settings) return Promise.resolve()
    this.loading ??= window.screenrx.meet
      .getSettings()
      .then(
        (settings) => this.update({ settings }),
        () => this.update({ settings: EMPTY_MEET_SETTINGS })
      )
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  async save(settings: MeetSettings): Promise<boolean> {
    this.update({ saving: true, failure: null })
    const result = await window.screenrx.meet.saveSettings(settings).catch(() => null)
    if (result?.ok) {
      this.update({ settings: result.value, saving: false })
      return true
    }
    this.update({ saving: false, failure: result?.error.message ?? 'Não foi possível salvar.' })
    return false
  }

  private update(patch: Partial<MeetSettingsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}

export const meetSettings = new MeetSettingsStore()

export function useMeetSettings(): MeetSettingsState {
  return useSyncExternalStore(meetSettings.subscribe, meetSettings.getState)
}

/** Whether the library should show meetings: address and token are both set. */
export function useMeetConfigured(): boolean {
  const { settings } = useMeetSettings()
  return settings !== null && isMeetConfigured(settings)
}
