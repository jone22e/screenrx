import { useSyncExternalStore } from 'react'

/** A request, from anywhere in the editor, that the sidebar show a tool; the sidebar reads it and clears it. */
class SidebarNavStore {
  private wanted: { tab: string; at: number } | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): { tab: string; at: number } | null => this.wanted

  open(tab: string): void {
    this.wanted = { tab, at: Date.now() }
    for (const listener of this.listeners) listener()
  }
}

export const sidebarNav = new SidebarNavStore()

export const useSidebarNav = (): { tab: string; at: number } | null => useSyncExternalStore(sidebarNav.subscribe, sidebarNav.getState)
