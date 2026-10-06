import { Menu, Tray, nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { TRAY_ICON_PNG_BASE64 } from './trayIcon'

export interface TrayActions {
  /** Left click: enter recording mode (the recording bar). */
  openRecorder: () => void
  showLibrary: () => void
  quit: () => void
}

/** The brand mark as a template image, so macOS tints it for light and dark menu bars. */
function trayImage(): NativeImage {
  const image = nativeImage.createEmpty()
  for (const scale of [1, 2] as const) {
    image.addRepresentation({
      scaleFactor: scale,
      buffer: Buffer.from(TRAY_ICON_PNG_BASE64[scale], 'base64')
    })
  }
  image.setTemplateImage(true)
  return image
}

/**
 * The icon in the menu bar: one click brings the recording bar up, so a
 * recording can start without going through the library window. The
 * right-click menu has the few things worth reaching from there.
 */
export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(trayImage())
  tray.setToolTip('ScreenRx — Nova gravação')
  tray.on('click', () => actions.openRecorder())
  tray.on('right-click', () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Nova gravação', click: () => actions.openRecorder() },
        { label: 'Abrir biblioteca', click: () => actions.showLibrary() },
        { type: 'separator' },
        { label: 'Sair do ScreenRx', click: () => actions.quit() }
      ])
    )
  })
  return tray
}
