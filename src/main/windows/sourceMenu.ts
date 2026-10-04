import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { Menu } from 'electron'
import type { CaptureSource, CaptureSourceCatalog } from '@shared/models/capture'
import { sourceLabel } from '@shared/models/capture'

const MAX_LABEL_LENGTH = 64

export interface SourceMenuOptions {
  window: BrowserWindow
  /** `null` when sources cannot be listed (typically: permission missing). */
  catalog: CaptureSourceCatalog | null
  selectedSourceId: string | null
  onSelect: (sourceId: string) => void
  onOpenMainWindow: () => void
}

/** Native source picker shown from the HUD; it can extend beyond the tiny HUD window. */
export function showSourceMenu(options: SourceMenuOptions): void {
  const { catalog, selectedSourceId, onSelect, onOpenMainWindow } = options
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
    template.push({ label: 'Telas', enabled: false }, ...catalog.displays.map(item))
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
