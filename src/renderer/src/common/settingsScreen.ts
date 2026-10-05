import { useSyncExternalStore } from 'react'

/**
 * Whether the settings screen is open. It is opened from several places (the
 * library, the editor's AI panel) and drawn over whatever is on screen, so
 * the editor underneath keeps its state.
 */
let open = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (open === next) return
  open = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const openSettings = (): void => set(true)
export const closeSettings = (): void => set(false)
export const useSettingsOpen = (): boolean => useSyncExternalStore(subscribe, () => open)
