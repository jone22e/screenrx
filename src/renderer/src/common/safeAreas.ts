import { useSyncExternalStore } from 'react'

const KEY = 'screenrx.preview.safe-areas'

/**
 * Whether the preview marks the parts of a vertical video that the social
 * apps' own buttons and captions cover. Off until asked for: unexplained
 * marks over the picture read as a flaw in the video. A preference of this
 * Mac, not of any project; the export never draws it.
 */
class SafeAreasStore {
  private shown: boolean
  private readonly listeners = new Set<() => void>()

  constructor() {
    try {
      this.shown = window.localStorage.getItem(KEY) === 'on'
    } catch {
      this.shown = false
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): boolean => this.shown

  set(shown: boolean): void {
    this.shown = shown
    try {
      window.localStorage.setItem(KEY, shown ? 'on' : 'off')
    } catch {
      // Not remembering the choice is no reason to fail.
    }
    for (const listener of this.listeners) listener()
  }
}

export const safeAreas = new SafeAreasStore()

export const useSafeAreas = (): boolean => useSyncExternalStore(safeAreas.subscribe, safeAreas.getState)
