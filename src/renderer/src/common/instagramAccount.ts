import type { InstagramStatus } from '@shared/models/instagram'

/**
 * Who the app publishes to, shared by the settings screen, the library and
 * the publish queue. The main process is the source; this keeps the last
 * answer and tells the screens when it changes.
 */
class InstagramAccountStore {
  private status: InstagramStatus | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): InstagramStatus | null => this.status

  async load(): Promise<InstagramStatus> {
    const status = await window.screenrx.instagram.status()
    this.set(status)
    return status
  }

  set(status: InstagramStatus): void {
    this.status = status
    for (const listener of this.listeners) listener()
  }
}

export const instagramAccount = new InstagramAccountStore()
