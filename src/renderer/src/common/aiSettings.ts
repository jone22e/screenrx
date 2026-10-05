import type { AiChoice, AiEffort, AiPreferences, AiProvider, AiProviderId } from '@shared/models/ai'
import { choiceFor, parseAiPreferences, readyProvider } from '@shared/models/ai'
import type { IpcResult } from '@shared/models/errors'

const PREFERENCES_KEY = 'screenrx.ai-preferences'

export interface AiSettingsState {
  /** The AI tools as they stand on this machine; `null` until first looked at. */
  providers: AiProvider[] | null
  preferences: AiPreferences
  /** Looking at the tools again. */
  checking: boolean
  /** An installation or a sign-in in progress. */
  activity: { provider: AiProviderId; kind: 'install' | 'login' } | null
  /** Why the last installation or sign-in did not finish. */
  failure: { provider: AiProviderId; message: string } | null
}

function storedPreferences(): AiPreferences {
  try {
    return parseAiPreferences(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? 'null'))
  } catch {
    return parseAiPreferences(null)
  }
}

/**
 * The AI tools and the user's choice among them, shared by the settings
 * screen and by whatever asks an AI for something. The choice is a
 * preference of this user on this machine, so it is kept by the window, not
 * in any project.
 */
class AiSettingsStore {
  private state: AiSettingsState = {
    providers: null,
    preferences: storedPreferences(),
    checking: false,
    activity: null,
    failure: null
  }
  private readonly listeners = new Set<() => void>()
  private loading: Promise<void> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): AiSettingsState => this.state

  /** Looks at the tools. Without `refresh`, a recent look is reused. */
  load(refresh = false): Promise<void> {
    if (this.loading && !refresh) return this.loading
    this.update({ checking: true })
    const loading = window.screenrx.ai
      .providers(refresh)
      .then(
        (providers) => this.update({ providers, checking: false }),
        () => this.update({ providers: this.state.providers ?? [], checking: false })
      )
      .finally(() => {
        if (this.loading === loading) this.loading = null
      })
    this.loading = loading
    return loading
  }

  useProvider(provider: AiProviderId): void {
    this.savePreferences({ ...this.state.preferences, provider })
  }

  setModel(provider: AiProviderId, model: string): void {
    const { preferences } = this.state
    this.savePreferences({ ...preferences, model: { ...preferences.model, [provider]: model } })
  }

  setEffort(provider: AiProviderId, effort: AiEffort): void {
    const { preferences } = this.state
    this.savePreferences({ ...preferences, effort: { ...preferences.effort, [provider]: effort } })
  }

  install(provider: AiProviderId): Promise<void> {
    return this.setUp(provider, 'install', () => window.screenrx.ai.install(provider))
  }

  login(provider: AiProviderId): Promise<void> {
    return this.setUp(provider, 'login', () => window.screenrx.ai.login(provider))
  }

  cancelSetup(): void {
    void window.screenrx.ai.cancelSetup()
  }

  private async setUp(
    provider: AiProviderId,
    kind: 'install' | 'login',
    run: () => Promise<IpcResult<AiProvider[]>>
  ): Promise<void> {
    if (this.state.activity) return
    this.update({ activity: { provider, kind }, failure: null })
    const result = await run().catch(() => null)
    if (result?.ok) {
      this.update({ providers: result.value, activity: null })
      return
    }
    this.update({
      activity: null,
      failure: { provider, message: result?.error.message ?? 'Não foi possível concluir.' }
    })
    // Something may have changed on the way (a cancelled install can still have finished).
    void this.load(true)
  }

  private savePreferences(preferences: AiPreferences): void {
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Without storage the choice still holds for this session.
    }
    this.update({ preferences })
  }

  private update(change: Partial<AiSettingsState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
}

export const aiSettings = new AiSettingsStore()

/** The tool, model and effort an AI request should use now; `null` when no tool is ready. */
export function currentAiChoice(state: AiSettingsState): { provider: AiProvider; choice: AiChoice } | null {
  const provider = state.providers ? readyProvider(state.providers, state.preferences) : null
  return provider ? { provider, choice: choiceFor(provider, state.preferences) } : null
}
