import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { app, dialog, screen, session } from 'electron'
import { appError } from '@shared/models/errors'
import { AiCliService } from './ai/AiCliService'
import { AiSetupService } from './ai/AiSetupService'
import { CaptionTranslationService } from './ai/CaptionTranslationService'
import { defaultAiSearchDirs } from './ai/cliProcess'
import { CutSuggestionService } from './ai/CutSuggestionService'
import { createCaptureEngine } from './capture/createCaptureEngine'
import { RoutingCaptureEngine } from './capture/RoutingCaptureEngine'
import { TranscriptionService } from './captions/TranscriptionService'
import { ExportService } from './export/ExportService'
import { FfmpegService, bundledFfmpegBinaries } from './export/FfmpegService'
import { DubbingService } from './dub/DubbingService'
import { registerIpc } from './ipc/registerIpc'
import { addLogSink, consoleSink, createLogger, fileSink } from './logging/logger'
import { ThumbnailService } from './media/ThumbnailService'
import { WaveformService } from './media/WaveformService'
import { registerMediaScheme, serveMedia } from './media/mediaProtocol'
import { MeetApi } from './meet/MeetApi'
import { MeetAudioCapture } from './meet/MeetAudioCapture'
import { MeetRecorder } from './meet/MeetRecorder'
import { OffscreenMeetingCapture } from './meet/OffscreenMeetingCapture'
import { MeetSettingsStore } from './meet/MeetSettingsStore'
import { ProjectStore } from './project/ProjectStore'
import { RecordingController } from './recording/RecordingController'
import { SessionStore } from './recording/SessionStore'
import { WindowManager } from './windows/WindowManager'
import { createTray } from './windows/tray'

const HELPER_BINARY = 'screenrx-capture'
const TRANSCRIBER_BINARY = 'screenrx-transcribe'
const VOICE_BINARY = 'screenrx-dub'

const logger = createLogger('app')

/** Development builds may redirect recordings (used by the end-to-end test). */
function recordingsRoot(): string {
  const override = app.isPackaged ? undefined : process.env['SCREENRX_RECORDINGS_DIR']
  return override ? path.resolve(override) : path.join(app.getPath('videos'), 'ScreenRx')
}

/**
 * Development builds may also point at another copy of the helper: macOS
 * allows only one capture client per executable, so the end-to-end test runs
 * its own copy to coexist with a development app that is already open.
 */
function helperPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'native', HELPER_BINARY)
  const override = process.env['SCREENRX_HELPER_PATH']
  return override
    ? path.resolve(override)
    : path.join(app.getAppPath(), 'dist-native', process.platform, HELPER_BINARY)
}

/** The speech-to-text helper; only macOS has one for now. */
function transcriberPath(): string | null {
  if (process.platform !== 'darwin') return null
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', TRANSCRIBER_BINARY)
    : path.join(app.getAppPath(), 'dist-native', process.platform, TRANSCRIBER_BINARY)
}

/**
 * The voice helper (dubbing in a cloned voice): Apple Silicon only, and built
 * separately (`npm run build:voice`), so a development checkout may not have
 * it. Development builds may point at a stand-in (the end-to-end test does).
 */
function voiceHelperPath(): string | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null
  if (app.isPackaged) return path.join(process.resourcesPath, 'native', VOICE_BINARY)
  const candidate = process.env['SCREENRX_VOICE_HELPER_PATH']
    ? path.resolve(process.env['SCREENRX_VOICE_HELPER_PATH'])
    : path.join(app.getAppPath(), 'dist-native', process.platform, VOICE_BINARY)
  return existsSync(candidate) ? candidate : null
}

/** Where the voice model is downloaded to: the app's own data. */
function voiceModelsDirectory(): string {
  const override = app.isPackaged ? undefined : process.env['SCREENRX_VOICE_MODELS_DIR']
  return override ? path.resolve(override) : path.join(app.getPath('userData'), 'voice-models')
}

/**
 * Where the AI command-line tools are looked for. Development builds may
 * point at a single directory instead (the end-to-end test puts a stand-in
 * there, so it never spends the user's AI quota).
 */
function aiSearchDirs(): string[] {
  const override = app.isPackaged ? undefined : process.env['SCREENRX_AI_CLI_DIR']
  return override ? [path.resolve(override)] : defaultAiSearchDirs(process.env, os.homedir())
}

/**
 * Where to save an export: the user picks it in a save dialog. Development
 * builds may redirect exports to a directory instead (used by the end-to-end
 * test, which cannot answer a native dialog).
 */
async function chooseExportPath(windows: WindowManager, fileName: string): Promise<string | null> {
  const directory = app.isPackaged ? undefined : process.env['SCREENRX_EXPORT_DIR']
  if (directory) {
    const extension = path.extname(fileName)
    const stem = path.basename(fileName, extension)
    for (let attempt = 0; ; attempt++) {
      const candidate = path.join(directory, attempt === 0 ? fileName : `${stem} (${attempt})${extension}`)
      if (!existsSync(candidate)) return candidate
    }
  }
  const options = {
    title: 'Exportar vídeo',
    defaultPath: path.join(app.getPath('videos'), fileName),
    filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }]
  }
  const owner = windows.mainWindow
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** Windows of every Electron app live in its main process. */
const ownPids = (): number[] => [process.pid]

async function bootstrap(): Promise<void> {
  addLogSink(consoleSink())
  addLogSink(fileSink(path.join(app.getPath('logs'), 'main.log')))
  logger.info('starting', { version: app.getVersion(), platform: process.platform })

  // Recording is done natively. The only web permission the renderers get is
  // the camera, for the live preview shown before recording.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const cameraOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === 'video'
    callback(cameraOnly && windows.owns(contents))
  })

  const windows = new WindowManager({
    preloadPath: path.join(__dirname, '../preload/index.js'),
    meetPreloadPath: path.join(__dirname, '../preload/meet.js'),
    rendererDirectory: path.join(__dirname, '../renderer'),
    rendererDevUrl: app.isPackaged ? null : (process.env['ELECTRON_RENDERER_URL'] ?? null),
    logger: createLogger('windows')
  })
  const ffmpeg = new FfmpegService(bundledFfmpegBinaries(), createLogger('export'))
  // Meetings are drawn off screen and recorded by the app itself; everything else by the platform engine.
  const offscreenMeeting = new OffscreenMeetingCapture(ffmpeg, createLogger('meet'))
  const engine = new RoutingCaptureEngine(createCaptureEngine({
    helperPath: helperPath(),
    // Electron names displays in the user's language, by the same id the system uses.
    displayName: (displayId) => screen.getAllDisplays().find((display) => display.id === displayId)?.label || null
  }), offscreenMeeting)
  const sessions = new SessionStore(recordingsRoot(), createLogger('sessions'))
  const projects = new ProjectStore(sessions, createLogger('autozoom'))
  // The audio of a meeting is captured inside its window and added to the session when it ends.
  const meetAudio = new MeetAudioCapture(path.join(app.getPath('userData'), 'meet-audio'), ffmpeg, createLogger('meet'))
  const controller = new RecordingController({
    engine,
    sessions,
    shield: windows,
    logger: createLogger('recording'),
    monotonicNow: () => performance.now(),
    wallClock: () => new Date(),
    ownPids,
    externalSystemAudio: (track) => meetAudio.finish(track)
  })

  let previous = controller.getState()
  controller.onStateChanged((state) => {
    windows.syncHud(state)
    windows.syncCameraPreview(state)
    windows.broadcast('recording:state-changed', state)
    // When a recording ends, or something goes wrong while setting one up, the
    // bar gives way to the library — where the new recording, or the reason, is shown.
    const recordingEnded = previous.phase !== 'idle' && state.phase === 'idle'
    const newError = state.phase === 'idle' && state.lastError !== null && state.lastError !== previous.lastError
    if (recordingEnded || newError) windows.showLibrary()
    previous = state
  })
  controller.onLibraryChanged(() => windows.broadcast('library:changed', null))

  const thumbnails = new ThumbnailService(path.join(app.getPath('userData'), 'thumbnails'), ffmpeg, sessions)
  serveMedia(sessions, thumbnails, createLogger('media'))
  const exports = new ExportService({
    ffmpeg,
    sessions,
    projects,
    logger: createLogger('export'),
    chooseOutputPath: (fileName) => chooseExportPath(windows, fileName)
  })

  const transcriptions = new TranscriptionService({
    binaryPath: transcriberPath(),
    sessions,
    logger: createLogger('captions'),
    onProgress: (progress) => windows.broadcast('captions:progress', progress)
  })

  const aiTools = { logger: createLogger('ai'), searchDirs: aiSearchDirs(), env: process.env }
  const ai = new AiCliService(aiTools)
  const aiSetup = new AiSetupService({ ...aiTools, home: os.homedir() })

  const dubbing = new DubbingService({
    helperPath: voiceHelperPath(),
    transcriberPath: transcriberPath(),
    modelsDirectory: voiceModelsDirectory(),
    ffmpeg,
    sessions,
    logger: createLogger('dub'),
    onProgress: (progress) => windows.broadcast('dub:progress', progress)
  })

  // Meetings of the meeting app (Screen Live): listed and recorded from the library.
  const meetSettings = new MeetSettingsStore(app.getPath('userData'), createLogger('meet'))
  const meet = new MeetRecorder({
    api: new MeetApi(),
    settings: meetSettings,
    audio: meetAudio,
    capture: offscreenMeeting,
    controller,
    windows,
    logger: createLogger('meet')
  })

  registerIpc({
    engine,
    controller,
    sessions,
    projects,
    exports,
    transcriptions,
    dubbing,
    suggestions: new CutSuggestionService(ai, sessions, createLogger('ai')),
    translations: new CaptionTranslationService(ai, createLogger('ai')),
    aiSetup,
    waveforms: new WaveformService(ffmpeg, sessions),
    thumbnails,
    meet,
    meetSettings,
    windows,
    logger: createLogger('ipc'),
    ownPids
  })

  await sessions.recoverInterrupted(appError('capture-helper-exited', 'found unfinished at startup'))

  // The app opens on the library; the recording bar appears on "Nova gravação".
  windows.showMain()
  void controller.selectDefaultSource()

  // The menu bar icon is the quickest way to a new recording — the same as
  // "Nova gravação" in the library. Kept referenced so it is never collected.
  const tray = createTray({
    openRecorder: () => {
      if (controller.getState().phase === 'idle') controller.dismissError()
      windows.openRecorder()
    },
    showLibrary: () => {
      if (controller.getState().phase === 'idle') windows.showLibrary()
    },
    quit: () => app.quit()
  })
  app.on('will-quit', () => tray.destroy())

  // Reopening the app (Dock, second launch) brings the library back, unless a
  // recording is running — then the bar is where the user needs to be.
  const reopen = (): void => {
    if (controller.getState().phase === 'idle') windows.showLibrary()
  }
  app.on('activate', reopen)
  app.on('second-instance', reopen)

  // Quitting mid-recording first finalizes the file, then lets the app exit.
  let readyToQuit = false
  app.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    void (async () => {
      try {
        transcriptions.cancel()
        ai.cancel()
        aiSetup.cancel()
        dubbing.cancel()
        await exports.cancel()
        await controller.shutdown()
        await engine.dispose()
      } catch (error) {
        logger.error('shutdown failed', { error: String(error) })
      } finally {
        readyToQuit = true
        app.quit()
      }
    })()
  })
}

registerMediaScheme()

if (app.requestSingleInstanceLock()) {
  // On macOS the app stays alive with the HUD when the main window is closed.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      process.stderr.write(`ScreenRx failed to start: ${String(error)}\n`)
      app.exit(1)
    })
} else {
  app.quit()
}
