import { useEffect, useSyncExternalStore } from 'react'
import type { UpdateState } from '@shared/models/update'

/**
 * The app's update state, shared by the library (which announces a version that is ready) and the
 * settings screen. The main process owns it and broadcasts every change.
 */
class UpdateStatusStore {
  private state: UpdateState | null = null
  private readonly listeners = new Set<() => void>()
  private listening = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): UpdateState | null => this.state

  async load(): Promise<void> {
    if (!this.listening) {
      this.listening = true
      window.screenrx.update.onStateChanged((state) => this.set(state))
    }
    this.set(await window.screenrx.update.getState())
  }

  async check(): Promise<void> {
    this.set(await window.screenrx.update.check())
  }

  /** Restarts into the downloaded version; false when a recording or an export is running. */
  install(): Promise<boolean> {
    return window.screenrx.update.install()
  }

  private set(state: UpdateState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

export const updateStatus = new UpdateStatusStore()

export function useUpdateStatus(): UpdateState | null {
  useEffect(() => {
    void updateStatus.load()
  }, [])
  return useSyncExternalStore(updateStatus.subscribe, updateStatus.getState)
}
