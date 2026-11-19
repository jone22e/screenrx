import { BrowserWindow, session } from 'electron'
import type { LoginWindow } from './InstagramService'

/**
 * Facebook's login, as a desktop app does it: Facebook's own page in a
 * window of its own (no preload, no access to the app), watched until it
 * goes to the redirect address with the token in the fragment. The sign-in
 * is kept in a session of its own, so the next login is one click.
 */
export function createLoginWindow(parent: () => BrowserWindow | null): LoginWindow {
  return (url, redirect) =>
    new Promise((resolve) => {
      const owner = parent()
      const window = new BrowserWindow({
        width: 560,
        height: 720,
        title: 'Conectar ao Instagram',
        ...(owner && { parent: owner, modal: false }),
        autoHideMenuBar: true,
        webPreferences: {
          session: session.fromPartition('persist:facebook-login'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
        if (!window.isDestroyed()) window.close()
      }
      // The redirect address has nothing behind it: it is caught and never loaded.
      const watch = (event: { preventDefault: () => void } | null, target: string): void => {
        if (!target.startsWith(redirect)) return
        event?.preventDefault()
        finish(target)
      }
      window.webContents.on('will-redirect', (event, target) => watch(event, target))
      window.webContents.on('will-navigate', (event, target) => watch(event, target))
      window.webContents.on('did-navigate', (_event, target) => watch(null, target))
      window.webContents.on('did-fail-load', (_event, _code, _description, target) => watch(null, target))
      // Pop-ups Facebook opens (help, terms) go nowhere.
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.on('closed', () => finish(null))
      void window.loadURL(url)
    })
}
