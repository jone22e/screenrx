import { useSyncExternalStore } from 'react'

const KEY = 'screenrx.preview.safe-areas'
const PHONE_KEY = 'screenrx.preview.phone-frame'

/**
 * Whether the preview marks the parts of a vertical video that the social
 * apps' own buttons and captions cover. Off until asked for: unexplained
 * marks over the picture read as a flaw in the video. A preference of this
 * Mac, not of any project; the export never draws it.
 */
class SafeAreasStore {
  private shown: boolean
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string = KEY) {
    try {
      this.shown = window.localStorage.getItem(this.key) === 'on'
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
      window.localStorage.setItem(this.key, shown ? 'on' : 'off')
    } catch {
      // Not remembering the choice is no reason to fail.
    }
    for (const listener of this.listeners) listener()
  }
}

export const safeAreas = new SafeAreasStore()

export const useSafeAreas = (): boolean => useSyncExternalStore(safeAreas.subscribe, safeAreas.getState)

/** Whether the preview shows a vertical video inside a phone, with the apps' bars drawn over it. Off until asked for; never exported. */
export const phoneFrame = new SafeAreasStore(PHONE_KEY)

export const usePhoneFrame = (): boolean => useSyncExternalStore(phoneFrame.subscribe, phoneFrame.getState)
