import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BrowserWindow, screen } from 'electron'
import type { IpcEventChannel, IpcEventContract } from '@shared/ipc/contract'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import type { Logger } from '../logging/logger'
import type { CaptureShield } from '../recording/RecordingController'
import { CAMERA_BUBBLE_LAYOUT, HUD_LAYOUT, hudWidthFor } from './hudLayout'

export interface WindowManagerOptions {
  preloadPath: string
  /** Preload of the meeting window: the audio bridge, nothing else. */
  meetPreloadPath: string
  /** Directory with the built renderer pages (production). */
  rendererDirectory: string
  /** Vite dev server origin, when running in development. */
  rendererDevUrl: string | null
  logger: Logger
}

type Page = 'index' | 'hud' | 'camera'

const MAIN_WINDOW_SIZE = { width: 980, height: 700, minWidth: 720, minHeight: 520 } as const
/** The meeting page is drawn at this size (even sides, as the video encoder needs) and recorded as is. */
const MEET_WINDOW_SIZE = { width: 1280, height: 720 } as const
/** Frames per second the meeting page is drawn at. */
const MEET_FRAME_RATE = 30
const WINDOW_BACKGROUND = '#17181c'

/**
 * Owns the app's windows — the main window, the always-on-top recording HUD
 * and the floating camera self-view — and acts as the capture shield that
 * keeps all of them out of recordings.
 */
export class WindowManager implements CaptureShield {
  private main: BrowserWindow | null = null
  private hud: BrowserWindow | null = null
  private camera: BrowserWindow | null = null
  /** The meeting being recorded: a page of the meeting app, not one of ours. */
  private meet: BrowserWindow | null = null
  private shielded = false
  /** Whether the app is in recording mode (bar up) rather than showing the library. */
  private recorderOpen = false
  private cameraSelected = false
  /** The library stays on screen while recording (a meeting's), where it shows the recording state. */
  private libraryHeld = false

  constructor(private readonly options: WindowManagerOptions) {}

  get hudWindow(): BrowserWindow | null {
    return this.hud
  }

  get mainWindow(): BrowserWindow | null {
    return this.main
  }

  /**
   * Keeps the library window on screen through the next recording instead of leaving the screen to the
   * recording bar: for a meeting recording, which has no bar and is controlled from the library.
   */
  holdLibrary(held: boolean): void {
    this.libraryHeld = held
  }

  get meetWindow(): BrowserWindow | null {
    return this.meet && !this.meet.isDestroyed() ? this.meet : null
  }

  /**
   * Opens the meeting page to be recorded — drawn off screen: there is no window to see, show, hide or
   * cover. Unlike the app's own windows it gets only the audio-bridge preload and is never trusted by the
   * app's IPC, and it is not part of the capture shield (it is the very thing being recorded).
   */
  openMeet(url: string): BrowserWindow {
    this.closeMeet()
    const origin = new URL(url).origin
    const window = new BrowserWindow({
      ...MEET_WINDOW_SIZE,
      title: 'Reunião',
      show: false,
      webPreferences: {
        preload: this.options.meetPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        offscreen: true,
        // The meeting's audio must play without a click: it is what gets recorded.
        autoplayPolicy: 'no-user-gesture-required',
        // Nothing is on screen to throttle the page by; keep it drawing at full rate.
        backgroundThrottling: false
      }
    })
    window.webContents.setFrameRate(MEET_FRAME_RATE)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== origin) {
        this.options.logger.warn('blocked navigation in meeting window', { url: target })
        event.preventDefault()
      }
    })
    window.on('closed', () => {
      if (this.meet === window) this.meet = null
    })
    this.meet = window
    window.loadURL(url).catch((error: unknown) => {
      this.options.logger.error('failed to load meeting page', { url, error: String(error) })
    })
    return window
  }

  closeMeet(): void {
    const window = this.meetWindow
    this.meet = null
    window?.close()
  }

  showMain(): void {
    if (!this.main) {
      this.main = this.createMain()
      return
    }
    if (this.main.isMinimized()) this.main.restore()
    this.main.show()
    this.main.focus()
  }

  /**
   * Recording mode: the library gets out of the way and the recording bar
   * comes up. The bar exists only while the user is about to record or recording.
   */
  openRecorder(): void {
    this.recorderOpen = true
    this.main?.hide()
    if (!this.hud) {
      this.hud = this.createHud()
    } else if (!this.hud.isVisible()) {
      this.hud.showInactive()
    }
    this.updateCameraPreview()
  }

  /** Back to the library: the bar and the camera self-view go away. */
  showLibrary(): void {
    this.dismissRecorder()
    this.showMain()
  }

  /** Puts the bar away without bringing the library up; the Dock icon reopens the app. */
  dismissRecorder(): void {
    this.recorderOpen = false
    this.hud?.hide()
    this.updateCameraPreview()
  }

  broadcast<Channel extends IpcEventChannel>(
    channel: Channel,
    payload: IpcEventContract[Channel]
  ): void {
    for (const window of this.windows()) window.webContents.send(channel, payload)
  }

  /** Tracks whether a camera is selected; the self-view follows it while the bar is up. */
  syncCameraPreview(state: RecordingStateSnapshot): void {
    this.cameraSelected = state.options.cameraId !== null
    this.updateCameraPreview()
  }

  private updateCameraPreview(): void {
    const wanted = this.cameraSelected && this.recorderOpen
    if (wanted && !this.camera) {
      this.camera = this.createCameraPreview()
    } else if (!wanted && this.camera) {
      this.camera.close()
    }
  }

  /** Resizes the HUD for the current phase, keeping it centred where the user left it. */
  syncHud(state: RecordingStateSnapshot): void {
    const hud = this.hud
    if (!hud || hud.isDestroyed()) return
    const width = hudWidthFor(state.phase)
    const bounds = hud.getBounds()
    if (bounds.width === width) return
    const centerX = bounds.x + bounds.width / 2
    hud.setBounds({
      x: Math.round(centerX - width / 2),
      y: bounds.y,
      width,
      height: HUD_LAYOUT.heightPt
    })
  }

  /** An IPC call is honoured only when it comes from the top frame of one of our own pages. */
  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    if (!this.owns(event.sender)) return false
    return this.isAppUrl(frame.url)
  }

  // MARK: CaptureShield

  /**
   * Belt and braces: the capture engine excludes this whole application from
   * the stream, and content protection additionally hides the windows from
   * screenshots and other recorders while the recording runs.
   */
  engage(): void {
    this.shielded = true
    for (const window of this.windows()) window.setContentProtection(true)
    // The bar is all the user needs while recording — unless the library is the one showing it.
    if (!this.libraryHeld) this.main?.hide()
  }

  release(): void {
    if (!this.shielded) return
    this.shielded = false
    for (const window of this.windows()) window.setContentProtection(false)
  }

  // MARK: windows

  private createMain(): BrowserWindow {
    const window = new BrowserWindow({
      ...MAIN_WINDOW_SIZE,
      title: 'ScreenRx',
      show: false,
      backgroundColor: WINDOW_BACKGROUND,
      titleBarStyle: 'hiddenInset',
      webPreferences: this.webPreferences()
    })
    this.harden(window.webContents)
    if (this.shielded) window.setContentProtection(true)
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      this.main = null
    })
    this.load(window, 'index')
    return window
  }

  private createHud(): BrowserWindow {
    const width = HUD_LAYOUT.idleWidthPt
    const height = HUD_LAYOUT.heightPt
    const workArea = screen.getPrimaryDisplay().workArea
    const window = new BrowserWindow({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: workArea.y + workArea.height - height - HUD_LAYOUT.bottomMarginPt,
      // A non-activating panel: using the HUD never steals focus from the app being recorded.
      type: 'panel',
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: this.webPreferences()
    })
    this.harden(window.webContents)
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    if (this.shielded) window.setContentProtection(true)
    window.once('ready-to-show', () => window.showInactive())
    window.on('closed', () => {
      this.hud = null
    })
    this.load(window, 'hud')
    return window
  }

  private createCameraPreview(): BrowserWindow {
    const size = CAMERA_BUBBLE_LAYOUT.sizePt
    const workArea = screen.getPrimaryDisplay().workArea
    const window = new BrowserWindow({
      width: size,
      height: size,
      x: workArea.x + CAMERA_BUBBLE_LAYOUT.marginPt,
      y: workArea.y + workArea.height - size - CAMERA_BUBBLE_LAYOUT.marginPt,
      type: 'panel',
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: this.webPreferences()
    })
    this.harden(window.webContents)
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    if (this.shielded) window.setContentProtection(true)
    window.once('ready-to-show', () => window.showInactive())
    window.on('closed', () => {
      this.camera = null
    })
    this.load(window, 'camera')
    return window
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: this.options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  }

  /** The renderers only ever show the app's own pages. */
  private harden(contents: WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      this.options.logger.warn('blocked navigation', { url })
      event.preventDefault()
    })
  }

  private load(window: BrowserWindow, page: Page): void {
    const { rendererDevUrl, rendererDirectory, logger } = this.options
    const loading = rendererDevUrl
      ? window.loadURL(`${rendererDevUrl}/${page}.html`)
      : window.loadFile(path.join(rendererDirectory, `${page}.html`))
    loading.catch((error: unknown) => logger.error('failed to load page', { page, error: String(error) }))
  }

  private windows(): BrowserWindow[] {
    return [this.main, this.hud, this.camera].filter(
      (window): window is BrowserWindow => window !== null && !window.isDestroyed()
    )
  }

  /** Whether `contents` belongs to one of the app's own windows. */
  owns(contents: WebContents): boolean {
    return this.windows().some((window) => window.webContents === contents)
  }

  private isAppUrl(url: string): boolean {
    const { rendererDevUrl, rendererDirectory } = this.options
    if (rendererDevUrl) return url.startsWith(`${rendererDevUrl}/`)
    return url.startsWith(`${pathToFileURL(rendererDirectory).href}/`)
  }
}
