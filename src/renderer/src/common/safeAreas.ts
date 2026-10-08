import { useSyncExternalStore } from 'react'

const KEY = 'screenrx.preview.safe-areas'

/**
 * Whether the preview marks the parts of a vertical video that the social
 * apps' own buttons and captions cover. A preference of this Mac, not of
 * any project; the export never draws it.
 */
class SafeAreasStore {
  private shown: boolean
  private readonly listeners = new Set<() => void>()

  constructor() {
    try {
      this.shown = window.localStorage.getItem(KEY) !== 'off'
    } catch {
      this.shown = true
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

/**
 * Where the apps' interface sits over a 9:16 video, as shares of the output:
 * the status bar and title at the top, the caption and music at the bottom,
 * the column of buttons on the right.
 */
export const SAFE_AREA_BANDS: ReadonlyArray<{ x: number; y: number; width: number; height: number }> = [
  { x: 0, y: 0, width: 1, height: 0.1 },
  { x: 0, y: 0.8, width: 1, height: 0.2 },
  { x: 0.84, y: 0.35, width: 0.16, height: 0.45 }
]
