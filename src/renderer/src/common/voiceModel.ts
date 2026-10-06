import type { DubProgress, DubStatus } from '@shared/models/dub'

export interface VoiceModelState {
  /** Where dubbing stands on this machine; `null` until first asked. */
  status: DubStatus | null
  /** The download (and unpacking) of the voice model, while it runs. */
  progress: DubProgress | null
  failure: string | null
}

/**
 * The voice model dubbing needs — a large download made once, only when the
 * user asks for it — shared by the settings screen and the editor.
 */
class VoiceModelStore {
  private state: VoiceModelState = { status: null, progress: null, failure: null }
  private readonly listeners = new Set<() => void>()
  private listening = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): VoiceModelState => this.state

  async refresh(): Promise<void> {
    this.listen()
    const status = await window.screenrx.dub.status().catch(() => null)
    if (status) this.update({ status })
  }

  /** Downloads the model. Nothing is downloaded before this is called. */
  async download(): Promise<void> {
    if (this.state.progress) return
    this.listen()
    this.update({ progress: { stage: 'downloading', fraction: 0 }, failure: null })
    const result = await window.screenrx.dub.prepareModel().catch(() => null)
    if (result?.ok) {
      this.update({ status: result.value, progress: null })
      return
    }
    this.update({
      progress: null,
      failure: result?.error.code === 'dub-cancelled' ? null : (result?.error.message ?? 'Não foi possível baixar o modelo de voz.')
    })
    void this.refresh()
  }

  cancel(): void {
    void window.screenrx.dub.cancel()
  }

  async remove(): Promise<void> {
    const result = await window.screenrx.dub.removeModel().catch(() => null)
    if (result?.ok) this.update({ status: result.value })
  }

  /** Progress of the download arrives as events from the main process. */
  private listen(): void {
    if (this.listening) return
    this.listening = true
    window.screenrx.dub.onProgress((progress) => {
      if (this.state.progress && (progress.stage === 'downloading' || progress.stage === 'unpacking')) {
        this.update({ progress })
      }
    })
  }

  private update(change: Partial<VoiceModelState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
}

export const voiceModel = new VoiceModelStore()
