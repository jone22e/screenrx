import type { ScreenRxApi } from '@shared/ipc/contract'

declare global {
  interface Window {
    /** Bridge exposed by the preload script; the renderer's only door to the system. */
    screenrx: ScreenRxApi
  }
}
