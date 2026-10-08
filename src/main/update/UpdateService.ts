import type { UpdateState } from '@shared/models/update'
import type { Logger } from '../logging/logger'

/** The part of electron-updater's `AppUpdater` this service uses, so tests can stand in for it. */
export interface UpdaterDriver {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceOptions {
  driver: UpdaterDriver
  /** Whether this is an installed build; only those can replace themselves. */
  packaged: boolean
  currentVersion: string
  logger: Logger
  /** Called with the new state every time it changes. */
  onChange: (state: UpdateState) => void
  /** Whether a recording or an export is running, which an installation must never interrupt. */
  busy: () => boolean
  now?: () => number
}

/** First look shortly after launch, once the window is up and the network is back. */
export const FIRST_CHECK_MS = 10_000
/** A release is seen within half an hour even if the app stays open for days. */
export const CHECK_INTERVAL_MS = 30 * 60 * 1000
/** Coming back to the app (focus, wake) only looks again if the last look is older than this. */
export const MIN_GAP_MS = 10 * 60 * 1000

/** A short message for the user; the updater's own errors carry HTTP headers and stacks. */
export function describeUpdateError(error: unknown): string {
  const text = String((error as Error)?.message ?? error)
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|ERR_INTERNET|ERR_NETWORK|ERR_NAME_NOT_RESOLVED/i.test(text)) {
    return 'Sem conexão com o servidor de atualizações.'
  }
  if (/404|latest.*\.yml/i.test(text)) return 'Nenhuma versão publicada foi encontrada.'
  return text.split('\n')[0]?.slice(0, 200) ?? 'Não foi possível verificar atualizações.'
}

/**
 * Keeps the app up to date from its GitHub releases: checks after launch, every half hour, and when
 * the user comes back to the app; downloads a newer version in the background and installs it when
 * the app quits (electron-updater does that by itself), or on request via `install`.
 */
export class UpdateService {
  private state: UpdateState
  private lastAttempt = 0
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private readonly now: () => number

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now
    this.state = { status: options.packaged ? 'idle' : 'unsupported', current: options.currentVersion }
  }

  getState(): UpdateState {
    return this.state
  }

  /** Starts the periodic checks. Does nothing for a build that cannot replace itself. */
  start(): void {
    const { driver, logger } = this.options
    if (!this.options.packaged) return

    driver.autoDownload = true
    // Quitting is the safe moment to swap the app: the quit handler has already finalized any recording.
    driver.autoInstallOnAppQuit = true
    driver.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }))
    driver.on('update-available', (info) => {
      logger.info('update available', { version: info.version })
      this.set({ status: 'downloading', version: info.version, percent: 0 })
    })
    driver.on('update-not-available', () =>
      this.set({ status: 'idle', version: undefined, percent: undefined, checkedAt: this.now() })
    )
    driver.on('download-progress', (progress) =>
      this.set({ status: 'downloading', percent: Math.round(progress.percent) })
    )
    driver.on('update-downloaded', (info) => {
      logger.info('update downloaded', { version: info.version })
      this.set({ status: 'ready', version: info.version, percent: 100, checkedAt: this.now() })
    })
    driver.on('error', (error) => {
      logger.warn('update failed', { error: String(error) })
      this.set({ status: 'error', error: describeUpdateError(error) })
    })

    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_MS))
    this.timers.push(setInterval(() => void this.check(), CHECK_INTERVAL_MS))
  }

  /** The user came back (window focus, Mac woke up): look again unless a look was made a moment ago. */
  checkIfStale(): void {
    if (this.now() - this.lastAttempt < MIN_GAP_MS) return
    void this.check()
  }

  /** Looks for a newer version now. A download in progress or a version already waiting is left alone. */
  async check(): Promise<UpdateState> {
    const { status } = this.state
    if (!this.options.packaged || status === 'checking' || status === 'downloading' || status === 'ready') {
      return this.state
    }
    this.lastAttempt = this.now()
    try {
      await this.options.driver.checkForUpdates()
    } catch (error) {
      // The driver also reports it through its 'error' event; this covers a failure before any event.
      this.set({ status: 'error', error: describeUpdateError(error) })
    }
    return this.state
  }

  /**
   * Restarts into the downloaded version. Refused while something is being recorded or exported: it
   * would cut the work short. Returns whether the restart was started.
   */
  install(): boolean {
    if (this.state.status !== 'ready' || this.options.busy()) return false
    this.options.logger.info('installing update', { version: this.state.version })
    this.options.driver.quitAndInstall()
    return true
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.timers = []
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onChange(this.state)
  }
}
