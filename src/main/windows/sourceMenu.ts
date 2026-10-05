import type { BrowserWindow, MenuItemConstructorOptions, NativeImage } from 'electron'
import { Menu, nativeImage } from 'electron'
import type { CaptureSource, CaptureSourceCatalog, DisplaySource } from '@shared/models/capture'
import { sourceLabel } from '@shared/models/capture'

const MAX_LABEL_LENGTH = 64
/** Width requested for the miniature of each display, in pixels (drawn at half that, for Retina). */
export const DISPLAY_THUMBNAIL_WIDTH_PX = 176
const THUMBNAIL_SCALE_FACTOR = 2

export interface SourceMenuOptions {
  window: BrowserWindow
  /** `null` when sources cannot be listed (typically: permission missing). */
  catalog: CaptureSourceCatalog | null
  selectedSourceId: string | null
  /** The display the recording bar is on, so the menu can say "this one". */
  barDisplayId: number | null
  /** Where every display sits on the desktop, as arranged in System Settings. */
  arrangement: readonly ArrangedDisplay[]
  onSelect: (sourceId: string) => void
  onOpenMainWindow: () => void
}

export interface ArrangedDisplay {
  displayId: number
  /** Position and size on the desktop, in points, y growing downwards. */
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * Where a display sits relative to the main one — "acima da principal" — or
 * `null` for the main display itself and for one whose place is unknown.
 * Two monitors of the same model have the same name and size: this, and the
 * miniature, are what tells them apart.
 */
export function placementOf(
  displayId: number,
  mainDisplayId: number | null,
  arrangement: readonly ArrangedDisplay[]
): string | null {
  const own = arrangement.find((entry) => entry.displayId === displayId)?.bounds
  const main = arrangement.find((entry) => entry.displayId === mainDisplayId)?.bounds
  if (!own || !main || displayId === mainDisplayId) return null
  const dx = own.x + own.width / 2 - (main.x + main.width / 2)
  const dy = own.y + own.height / 2 - (main.y + main.height / 2)
  // Whichever way the two are further apart, measured in their own sizes.
  const sideways = Math.abs(dx) / ((own.width + main.width) / 2)
  const upright = Math.abs(dy) / ((own.height + main.height) / 2)
  if (sideways === 0 && upright === 0) return null
  if (upright > sideways) return dy < 0 ? 'acima da principal' : 'abaixo da principal'
  return dx < 0 ? 'à esquerda da principal' : 'à direita da principal'
}

/**
 * What tells one monitor from another, under its name: its size in points
 * (the resolution the user picked in System Settings), whether it is the
 * main one or where it sits next to it, and whether the recording bar is on it.
 */
export function displayDetail(
  display: DisplaySource,
  barDisplayId: number | null,
  placement: string | null = null
): string {
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const parts = [`${Math.round(display.widthPx / scale)} × ${Math.round(display.heightPx / scale)}`]
  if (display.isMain) parts.push('principal')
  else if (placement) parts.push(placement)
  if (display.displayId === barDisplayId) parts.push('onde está esta barra')
  return parts.join(' · ')
}

/** A miniature of what is on the display right now: the surest way to recognise it. */
function miniature(display: DisplaySource): NativeImage | null {
  const encoded = /^data:image\/jpeg;base64,(.+)$/.exec(display.thumbnailDataUrl ?? '')?.[1]
  if (!encoded) return null
  const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'), { scaleFactor: THUMBNAIL_SCALE_FACTOR })
  return image.isEmpty() ? null : image
}

/** Native source picker shown from the HUD; it can extend beyond the tiny HUD window. */
export function showSourceMenu(options: SourceMenuOptions): void {
  const { catalog, selectedSourceId, barDisplayId, arrangement, onSelect, onOpenMainWindow } = options
  const template: MenuItemConstructorOptions[] = []

  if (!catalog) {
    template.push({ label: 'Permitir gravação de tela…', click: onOpenMainWindow })
  } else {
    const item = (source: CaptureSource): MenuItemConstructorOptions => ({
      label: truncate(sourceLabel(source)),
      type: 'checkbox',
      checked: source.id === selectedSourceId,
      click: () => onSelect(source.id)
    })
    const mainDisplayId = catalog.displays.find((display) => display.isMain)?.displayId ?? null
    const displayItem = (display: DisplaySource): MenuItemConstructorOptions => {
      const icon = miniature(display)
      const placement = placementOf(display.displayId, mainDisplayId, arrangement)
      return { ...item(display), sublabel: displayDetail(display, barDisplayId, placement), ...(icon ? { icon } : {}) }
    }
    template.push({ label: 'Telas', enabled: false }, ...catalog.displays.map(displayItem))
    if (catalog.windows.length > 0) {
      template.push(
        { type: 'separator' },
        { label: 'Janelas', enabled: false },
        ...catalog.windows.map(item)
      )
    }
    template.push({ type: 'separator' }, { label: 'Voltar às gravações', click: onOpenMainWindow })
  }

  Menu.buildFromTemplate(template).popup({ window: options.window })
}

function truncate(label: string): string {
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label
}
