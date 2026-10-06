import type { BrowserWindow } from 'electron'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { MeetRoom, MeetSettings } from '@shared/models/meet'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import { normalizeSessionTitle } from '@shared/models/session'
import type { Logger } from '../logging/logger'
import type { RecordingController } from '../recording/RecordingController'
import type { WindowManager } from '../windows/WindowManager'
import { MeetError } from './MeetApi'
import type { MeetApi } from './MeetApi'
import type { MeetAudioCapture } from './MeetAudioCapture'
import type { OffscreenMeetingCapture } from './OffscreenMeetingCapture'
import type { MeetSettingsStore } from './MeetSettingsStore'

export interface MeetRecorderDeps {
  api: MeetApi
  settings: MeetSettingsStore
  /** Receives the meeting's audio from the window; becomes the recording's system-audio track. */
  audio: MeetAudioCapture
  /** Draws the meeting off screen and records its frames. */
  capture: OffscreenMeetingCapture
  controller: RecordingController
  windows: WindowManager
  logger: Logger
}

/** What the meeting is called as a recording source ("Screen Live — <room>"), since there is no real window or app. */
const SOURCE_APP_NAME = 'Screen Live'
/** How the recorder shows up to the meeting (never as a person: it joins with a recorder token). */
const RECORDER_NAME = 'Gravação ScreenRx'
/** How long the meeting page gets to join the room before giving up. */
const JOIN_TIMEOUT_MS = 20_000
const JOIN_POLL_MS = 500

/**
 * Records a meeting of the meeting app: joins the room as a recorder in a
 * window of this app, then records that window with its audio through the
 * regular recording pipeline. The window closes when the recording ends,
 * and closing the window ends the recording.
 */
export class MeetRecorder {
  private window: BrowserWindow | null = null
  /** Set while a recording of a meeting is being prepared or is running. */
  private busy = false

  constructor(private readonly deps: MeetRecorderDeps) {
    deps.controller.onStateChanged((state) => this.followRecording(state))
  }

  async listRooms(): Promise<MeetRoom[]> {
    return this.deps.api.listRooms(await this.deps.settings.get())
  }

  /** Joins and starts recording; throws a `MeetError` when it cannot. */
  async record(code: string): Promise<void> {
    const { controller, windows, logger } = this.deps
    if (this.busy || controller.getState().phase !== 'idle') {
      throw new MeetError(appError('invalid-state', 'a recording is already running'))
    }
    this.busy = true
    try {
      const settings = await this.deps.settings.get()
      const ticket = await this.deps.api.issueRecorderToken(settings, code, RECORDER_NAME)
      const window = windows.openMeet(ticket.url)
      this.window = window
      const source = this.deps.capture.register(window, code, SOURCE_APP_NAME)
      await this.deps.audio.prepare(window.webContents, new URL(ticket.url).origin)
      window.on('closed', () => {
        if (this.window !== window) return
        this.window = null
        // Closing the meeting window is the other way to end the recording.
        if (controller.getState().phase !== 'idle') void controller.stop()
      })

      const status = await this.waitForJoin(settings, code, window)
      const meetingName = status.name && status.name !== 'Reunião' ? status.name : code
      await controller.useSource({ ...source, title: meetingName }, normalizeSessionTitle(`Reunião · ${meetingName}`))
      await controller.setMicrophone(null)
      await controller.setCamera(null)
      // The meeting's audio is captured in its page and added to the session when the recording ends.
      await controller.setSystemAudio(false)
      // No recording bar for a meeting: the library stays up and shows that it is recording.
      windows.holdLibrary(true)
      windows.showMain()
      await controller.start()
      const state = controller.getState()
      if (state.phase === 'idle' || state.sessionId === null) {
        throw new MeetError(state.lastError ?? appError('capture-failed'))
      }
      logger.info('meeting recording started', { code, sessionId: state.sessionId })
    } catch (error) {
      this.closeWindow()
      windows.showLibrary()
      throw error instanceof MeetError ? error : new MeetError(appError('meet-join-failed', String(error)))
    } finally {
      this.busy = false
    }
  }

  /** The room reports `recording: true` once the recorder's page has joined. */
  private async waitForJoin(settings: MeetSettings, code: string, window: BrowserWindow): Promise<{ name: string }> {
    const deadline = Date.now() + JOIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (window.isDestroyed()) throw new MeetError(appError('meet-join-failed', 'meeting window closed'))
      const status = await this.deps.api.roomStatus(settings, code)
      if (status.active && status.recording) return { name: status.name }
      await new Promise((resolve) => setTimeout(resolve, JOIN_POLL_MS))
    }
    throw new MeetError(appError('meet-join-failed', 'timed out waiting for the room to report the recorder'))
  }

  private followRecording(state: RecordingStateSnapshot): void {
    if (state.phase === 'idle' && !this.busy && this.window) this.closeWindow()
  }

  private closeWindow(): void {
    this.window = null
    this.deps.windows.holdLibrary(false)
    this.deps.windows.closeMeet()
    this.deps.capture.release()
    // A recording that ended already took the audio (finish discards it); this covers one that never started.
    void this.deps.audio.discard()
  }
}

export function toMeetAppError(error: unknown): AppError {
  return error instanceof MeetError ? error.appError : appError('unknown', String(error))
}
