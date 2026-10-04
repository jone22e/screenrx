/** A display or window that can be recorded. */
export type CaptureSource = DisplaySource | WindowSource

export interface DisplaySource {
  kind: 'display'
  /** Stable identifier within the app, e.g. `display:1`. */
  id: string
  displayId: number
  /** 1-based position, main display first ("Display 1"). */
  index: number
  /** Name reported by the system, e.g. "Built-in Retina Display". */
  name: string
  isMain: boolean
  widthPx: number
  heightPx: number
  scaleFactor: number
  thumbnailDataUrl: string | null
}

export interface WindowSource {
  kind: 'window'
  /** Stable identifier within the app, e.g. `window:4821`. */
  id: string
  windowId: number
  title: string
  appName: string
  bundleId: string
  /** Display the window currently sits on, when it can be determined. */
  displayId: number | null
  widthPx: number
  heightPx: number
  thumbnailDataUrl: string | null
}

export interface CaptureSourceCatalog {
  displays: DisplaySource[]
  windows: WindowSource[]
}

const SOURCE_ID_PATTERN = /^(display|window):(\d{1,10})$/

export function displaySourceId(displayId: number): string {
  return `display:${displayId}`
}

export function windowSourceId(windowId: number): string {
  return `window:${windowId}`
}

export function isCaptureSourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ID_PATTERN.test(value)
}

/** Short label used in menus and in the HUD. */
export function sourceLabel(source: CaptureSource): string {
  return source.kind === 'display'
    ? `Display ${source.index}`
    : `${source.appName} — ${source.title}`
}

export function findSource(catalog: CaptureSourceCatalog, id: string): CaptureSource | null {
  return (
    catalog.displays.find((display) => display.id === id) ??
    catalog.windows.find((window) => window.id === id) ??
    null
  )
}
