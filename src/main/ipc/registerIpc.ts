import { access } from 'node:fs/promises'
import { Menu, app, dialog, ipcMain, screen, shell } from 'electron'
import type { IpcInvokeChannel, IpcInvokeContract } from '@shared/ipc/contract'
import type { AiProvider } from '@shared/models/ai'
import { isAiProviderId, parseAiChoice } from '@shared/models/ai'
import { parseCaptionTranslationRequest, parseTranscriptionRequest } from '@shared/models/captions'
import type { CaptureSourceCatalog } from '@shared/models/capture'
import { isDeviceId } from '@shared/models/devices'
import { parseDubRequest } from '@shared/models/dub'
import type { AppError, IpcResult } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import { isPermissionKind } from '@shared/models/permissions'
import { parseProject } from '@shared/models/project'
import type { PermissionKind, PermissionReport } from '@shared/models/permissions'
import { isSessionId, normalizeSessionTitle } from '@shared/models/session'
import type { ProjectStore } from '../project/ProjectStore'
import { isExportTrackName } from '@shared/models/export'
import { AiError } from '../ai/AiCliService'
import { AI_PROVIDER_SPECS } from '../ai/aiCatalog'
import type { AiSetupService } from '../ai/AiSetupService'
import type { CaptionTranslationService } from '../ai/CaptionTranslationService'
import type { CutSuggestionService } from '../ai/CutSuggestionService'
import { TranscriptionError } from '../captions/TranscriptionService'
import { DubError } from '../dub/DubbingService'
import type { DubbingService } from '../dub/DubbingService'
import type { TranscriptionService } from '../captions/TranscriptionService'
import type { CaptureEngine } from '../capture/CaptureEngine'
import { CaptureError } from '../capture/CaptureEngine'
import { ExportError } from '../export/ExportService'
import type { ExportService } from '../export/ExportService'
import type { Logger } from '../logging/logger'
import type { ThumbnailService } from '../media/ThumbnailService'
import type { WaveformService } from '../media/WaveformService'
import { isAudioTrackName } from '../media/WaveformService'
import type { RecordingController } from '../recording/RecordingController'
import type { SessionStore } from '../recording/SessionStore'
import type { WindowManager } from '../windows/WindowManager'
import type { DeviceMenuActions } from '../windows/deviceMenus'
import { showCameraMenu, showMicrophoneMenu } from '../windows/deviceMenus'
import { DISPLAY_THUMBNAIL_WIDTH_PX, showSourceMenu } from '../windows/sourceMenu'

export interface IpcDependencies {
  engine: CaptureEngine
  controller: RecordingController
  sessions: SessionStore
  projects: ProjectStore
  exports: ExportService
  transcriptions: TranscriptionService
  suggestions: CutSuggestionService
  translations: CaptionTranslationService
  dubbing: DubbingService
  aiSetup: AiSetupService
  waveforms: WaveformService
  thumbnails: ThumbnailService
  windows: WindowManager
  logger: Logger
  ownPids: () => number[]
}

type Result<Channel extends IpcInvokeChannel> = IpcInvokeContract[Channel]['result']

const SYSTEM_SETTINGS_URLS: Record<PermissionKind, string> = {
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
}

/**
 * Registers every channel of the IPC contract. Arguments arrive as
 * `unknown` and are validated here: the renderer is never trusted with
 * paths, only with ids that the main process resolves itself.
 */
export function registerIpc(deps: IpcDependencies): void {
  const {
    engine,
    controller,
    sessions,
    projects,
    exports,
    transcriptions,
    suggestions,
    translations,
    dubbing,
    aiSetup,
    waveforms,
    thumbnails,
    windows,
    logger,
    ownPids
  } = deps

  function handle<Channel extends IpcInvokeChannel>(
    channel: Channel,
    handler: (args: unknown[]) => Promise<Result<Channel>> | Result<Channel>
  ): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!windows.isTrustedSender(event)) {
        logger.warn('rejected call from untrusted sender', { channel, url: event.senderFrame?.url })
        throw new Error('Forbidden')
      }
      return handler(args)
    })
  }

  const permissionReport = (check: () => Promise<PermissionReport>) =>
    toResult(async () => {
      const report = await check()
      if (report.permissions.screenRecording === 'granted') void controller.selectDefaultSource()
      return report
    })

  handle('permissions:get', () => permissionReport(() => engine.getPermissions()))

  handle('permissions:request-screen-recording', () =>
    permissionReport(() => engine.requestScreenRecordingPermission())
  )

  handle('permissions:open-settings', async ([kind]) => {
    if (!isPermissionKind(kind) || process.platform !== 'darwin') return
    await shell.openExternal(SYSTEM_SETTINGS_URLS[kind])
  })

  handle('devices:list', () => toResult(() => engine.listDevices()))

  handle('recording:get-state', () => controller.getState())

  /** `null` turns the device off; anything else must look like a device id. */
  const deviceArgument = (value: unknown): string | null | undefined =>
    value === null ? null : isDeviceId(value) ? value : undefined

  handle('recording:set-microphone', async ([value]) => {
    const deviceId = deviceArgument(value)
    if (deviceId !== undefined) await controller.setMicrophone(deviceId)
    return controller.getState()
  })

  handle('recording:set-system-audio', async ([enabled]) => {
    if (typeof enabled === 'boolean') await controller.setSystemAudio(enabled)
    return controller.getState()
  })

  handle('recording:set-camera', async ([value]) => {
    const deviceId = deviceArgument(value)
    if (deviceId !== undefined) await controller.setCamera(deviceId)
    return controller.getState()
  })

  handle('recording:start', async () => {
    await controller.start()
    return controller.getState()
  })

  handle('recording:pause', async () => {
    await controller.pause()
    return controller.getState()
  })

  handle('recording:resume', async () => {
    await controller.resume()
    return controller.getState()
  })

  handle('recording:stop', async () => {
    await controller.stop()
    return controller.getState()
  })

  handle('recording:dismiss-error', () => {
    controller.dismissError()
    return controller.getState()
  })

  handle('library:list', () => sessions.list())

  handle('library:open-video', ([sessionId]) =>
    withScreenTrack(sessionId, async (screenPath) => {
      const failure = await shell.openPath(screenPath)
      if (failure) throw new Error(failure)
    })
  )

  handle('library:reveal', ([sessionId]) =>
    withScreenTrack(sessionId, async (screenPath) => shell.showItemInFolder(screenPath))
  )

  handle('library:delete', async ([sessionId]) => {
    if (!isSessionId(sessionId) || controller.getState().sessionId === sessionId) {
      return { ok: false, error: appError('invalid-state', 'session cannot be deleted') }
    }
    const owner = windows.mainWindow
    const options = {
      type: 'warning' as const,
      message: 'Excluir esta gravação?',
      detail: 'A gravação e a edição dela vão para a Lixeira.',
      buttons: ['Mover para a Lixeira', 'Cancelar'],
      defaultId: 0,
      cancelId: 1
    }
    const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (answer.response !== 0) return { ok: true, value: { deleted: false } }
    try {
      // The Trash, not a permanent delete: a mistake can be undone in Finder.
      await shell.trashItem(sessions.directoryOf(sessionId))
      await thumbnails.discard(sessionId)
      logger.info('recording moved to the Trash', { sessionId })
      windows.broadcast('library:changed', null)
      return { ok: true, value: { deleted: true } }
    } catch (error) {
      logger.error('could not delete recording', { sessionId, error: String(error) })
      return { ok: false, error: appError('storage-unavailable', String(error)) }
    }
  })

  handle('library:rename', async ([sessionId, title]) => {
    if (!isSessionId(sessionId) || typeof title !== 'string') {
      return { ok: false, error: appError('invalid-state', 'invalid rename') }
    }
    try {
      const renamed = await sessions.rename(sessionId, normalizeSessionTitle(title))
      if (!renamed) return { ok: false, error: appError('invalid-state', 'session not found') }
      windows.broadcast('library:changed', null)
      return { ok: true, value: null }
    } catch (error) {
      logger.error('could not rename recording', { sessionId, error: String(error) })
      return { ok: false, error: appError('storage-unavailable', String(error)) }
    }
  })

  handle('hud:show-source-menu', async () => {
    const hud = windows.hudWindow
    if (!hud || controller.getState().phase !== 'idle') return
    let catalog: CaptureSourceCatalog | null = null
    try {
      // Displays come with a miniature of what is on them, to tell them apart;
      // windows are listed by name only, so the menu opens quickly.
      const [withMiniatures, withWindows] = await Promise.all([
        engine.listSources({
          excludePids: ownPids(),
          includeWindows: false,
          thumbnailMaxWidthPx: DISPLAY_THUMBNAIL_WIDTH_PX
        }),
        engine.listSources({ excludePids: ownPids(), includeWindows: true, thumbnailMaxWidthPx: null })
      ])
      catalog = { displays: withMiniatures.displays, windows: withWindows.windows }
    } catch (error) {
      logger.info('source menu unavailable', { error: String(error) })
    }
    showSourceMenu({
      window: hud,
      catalog,
      selectedSourceId: controller.getState().selectedSource?.id ?? null,
      // On macOS Electron's display id is the system's own, the one sources are listed by.
      barDisplayId: screen.getDisplayMatching(hud.getBounds()).id,
      arrangement: screen.getAllDisplays().map((display) => ({ displayId: display.id, bounds: display.bounds })),
      onSelect: (sourceId) => void controller.selectSource(sourceId),
      onOpenMainWindow: () => windows.showLibrary()
    })
  })

  handle('editor:open', async ([sessionId]) => {
    if (!isSessionId(sessionId)) {
      return { ok: false, error: appError('unknown', 'invalid session id') }
    }
    try {
      return { ok: true, value: await projects.open(sessionId) }
    } catch (error) {
      logger.warn('could not open recording in the editor', { sessionId, error: String(error) })
      return { ok: false, error: appError('recording-invalid', String(error)) }
    }
  })

  handle('project:save', async ([value]) => {
    // The session id is taken from the payload only after it proves to be well-formed.
    const sessionId = (value as { sessionId?: unknown } | null)?.sessionId
    const project = isSessionId(sessionId) ? parseProject(value, sessionId) : null
    if (!project) {
      logger.warn('rejected malformed project')
      return { ok: false, error: appError('unknown', 'invalid project') }
    }
    try {
      await projects.save(project)
      return { ok: true, value: null }
    } catch (error) {
      logger.error('could not save project', { sessionId, error: String(error) })
      return { ok: false, error: appError('storage-unavailable', String(error)) }
    }
  })

  handle('captions:generate', async ([sessionId, value]) => {
    const request = parseTranscriptionRequest(value)
    if (!isSessionId(sessionId) || !request) {
      return { ok: false, error: appError('transcription-failed', 'invalid transcription request') }
    }
    try {
      return { ok: true, value: await transcriptions.generate(sessionId, request) }
    } catch (error) {
      const failure =
        error instanceof TranscriptionError ? error.appError : appError('transcription-failed', String(error))
      if (failure.code !== 'transcription-cancelled') {
        logger.error('transcription failed', { sessionId, code: failure.code, detail: failure.detail })
      }
      return { ok: false, error: failure }
    }
  })

  handle('captions:cancel', () => transcriptions.cancel())

  const dubResult = async <T>(operation: () => Promise<T>): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const failure = error instanceof DubError ? error.appError : appError('dub-failed', String(error))
      if (failure.code !== 'dub-cancelled') {
        logger.error('dubbing failed', { code: failure.code, detail: failure.detail })
      }
      return { ok: false, error: failure }
    }
  }

  handle('dub:status', () => dubbing.status())
  handle('dub:prepare-model', () => dubResult(() => dubbing.prepareModel()))
  handle('dub:remove-model', () => dubResult(() => dubbing.removeModel()))
  handle('dub:generate', ([sessionId, value]) => {
    const request = parseDubRequest(value)
    if (!isSessionId(sessionId) || !request) {
      return { ok: false, error: appError('dub-failed', 'invalid dubbing request') }
    }
    return dubResult(() => dubbing.generate(sessionId, request))
  })
  handle('dub:cancel', () => dubbing.cancel())

  handle('ai:providers', ([refresh]) => aiSetup.providers(refresh === true))

  const aiSetupResult = async (
    fallback: 'ai-install-failed' | 'ai-login-failed',
    operation: () => Promise<AiProvider[]>
  ): Promise<IpcResult<AiProvider[]>> => {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const failure = error instanceof AiError ? error.appError : appError(fallback, String(error))
      logger.warn('AI tool setup failed', { code: failure.code, detail: failure.detail })
      return { ok: false, error: failure }
    }
  }

  handle('ai:install', async ([provider]) => {
    if (!isAiProviderId(provider)) return { ok: false, error: appError('ai-install-failed', 'unknown tool') }
    // Installing downloads and runs the vendor's installer: never without the user saying so.
    const spec = AI_PROVIDER_SPECS[provider]
    const owner = windows.mainWindow
    const options = {
      type: 'question' as const,
      message: `Instalar o ${spec.toolName}?`,
      detail: `O ScreenRx vai baixar e executar o instalador oficial (${spec.installer}). A ferramenta é instalada na sua pasta pessoal, em ~/.local/bin.`,
      buttons: ['Instalar', 'Cancelar'],
      defaultId: 0,
      cancelId: 1
    }
    const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (answer.response !== 0) return { ok: true, value: await aiSetup.providers() }
    return aiSetupResult('ai-install-failed', () => aiSetup.install(provider))
  })

  handle('ai:login', ([provider]) =>
    isAiProviderId(provider)
      ? aiSetupResult('ai-login-failed', () => aiSetup.login(provider))
      : { ok: false, error: appError('ai-login-failed', 'unknown tool') }
  )

  handle('ai:cancel-setup', () => aiSetup.cancel())

  handle('ai:suggest-cuts', async ([sessionId, value]) => {
    const choice = parseAiChoice(value)
    if (!isSessionId(sessionId) || !choice) {
      return { ok: false, error: appError('ai-failed', 'invalid suggestion request') }
    }
    try {
      return { ok: true, value: await suggestions.suggest(sessionId, choice) }
    } catch (error) {
      const failure = error instanceof AiError ? error.appError : appError('ai-failed', String(error))
      if (failure.code !== 'ai-cancelled') {
        logger.error('cut suggestions failed', {
          sessionId,
          provider: choice.provider,
          code: failure.code,
          detail: failure.detail
        })
      }
      return { ok: false, error: failure }
    }
  })

  handle('ai:cancel', () => suggestions.cancel())

  handle('captions:translate', async ([value, chosen]) => {
    const request = parseCaptionTranslationRequest(value)
    const choice = parseAiChoice(chosen)
    if (!request || !choice) return { ok: false, error: appError('ai-failed', 'invalid translation request') }
    try {
      return {
        ok: true,
        value: await translations.translate(request.cues, request.sourceLocale, request.language, choice)
      }
    } catch (error) {
      const failure = error instanceof AiError ? error.appError : appError('ai-failed', String(error))
      if (failure.code !== 'ai-cancelled') {
        logger.error('caption translation failed', {
          provider: choice.provider,
          language: request.language,
          code: failure.code,
          detail: failure.detail
        })
      }
      return { ok: false, error: failure }
    }
  })

  const exportResult = async <T>(operation: () => Promise<T>): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const failure = error instanceof ExportError ? error.appError : appError('export-failed', String(error))
      if (failure.code !== 'export-cancelled') {
        logger.error('export failed', { code: failure.code, detail: failure.detail })
      }
      return { ok: false, error: failure }
    }
  }
  const isExportId = (value: unknown): value is string => typeof value === 'string' && value.length <= 64

  handle('export:start', ([sessionId]) =>
    exportResult(async () => {
      if (!isSessionId(sessionId)) throw new ExportError(appError('export-failed', 'invalid session id'))
      return exports.start(sessionId)
    })
  )

  handle('export:read-chunk', async ([exportId, track, offset, length]) => {
    if (!isExportId(exportId) || !isExportTrackName(track)) throw new Error('Invalid chunk request')
    return exports.readChunk(exportId, track, Number(offset), Number(length))
  })

  handle('export:write-frame', ([exportId, frame]) =>
    exportResult(async () => {
      if (!isExportId(exportId) || !(frame instanceof Uint8Array)) {
        throw new ExportError(appError('export-failed', 'invalid frame'))
      }
      await exports.writeFrame(exportId, frame)
      return null
    })
  )

  handle('export:finish', ([exportId]) =>
    exportResult(async () => {
      if (!isExportId(exportId)) throw new ExportError(appError('export-failed', 'invalid export id'))
      return exports.finish(exportId)
    })
  )

  handle('export:cancel', async ([exportId]) => {
    if (isExportId(exportId)) await exports.cancel(exportId)
  })

  handle('export:reveal', ([exportId]) => {
    const exportedPath = isExportId(exportId) ? exports.pathOf(exportId) : null
    if (exportedPath) shell.showItemInFolder(exportedPath)
  })

  const deviceActions: DeviceMenuActions = {
    setMicrophone: (deviceId) => void controller.setMicrophone(deviceId),
    setCamera: (deviceId) => void controller.setCamera(deviceId)
  }

  const showDeviceMenu = async (kind: 'microphone' | 'camera'): Promise<void> => {
    const hud = windows.hudWindow
    if (!hud || controller.getState().phase !== 'idle') return
    const devices = await engine.listDevices().catch((error: unknown) => {
      logger.warn('could not list devices', { error: String(error) })
      return { microphones: [], cameras: [] }
    })
    const options = controller.getState().options
    if (kind === 'microphone') showMicrophoneMenu(hud, devices.microphones, options, deviceActions)
    else showCameraMenu(hud, devices.cameras, options, deviceActions)
  }

  handle('hud:show-microphone-menu', () => showDeviceMenu('microphone'))
  handle('hud:show-camera-menu', () => showDeviceMenu('camera'))

  handle('editor:waveform', async ([sessionId, track]) => {
    if (!isSessionId(sessionId) || !isAudioTrackName(track)) {
      return { ok: false, error: appError('unknown', 'invalid waveform request') }
    }
    try {
      return { ok: true, value: await waveforms.peaks(sessionId, track) }
    } catch (error) {
      logger.warn('could not compute waveform', { sessionId, track, error: String(error) })
      return { ok: false, error: appError('recording-invalid', String(error)) }
    }
  })

  handle('hud:show-options-menu', () => {
    const hud = windows.hudWindow
    if (!hud) return
    const recording = controller.getState().phase !== 'idle'
    Menu.buildFromTemplate([
      { label: 'Voltar às gravações', enabled: !recording, click: () => windows.showLibrary() },
      { type: 'separator' },
      { label: 'Sair do ScreenRx', enabled: !recording, click: () => app.quit() }
    ]).popup({ window: hud })
  })

  handle('hud:minimize', () => {
    // The HUD must stay on screen for as long as a recording is running.
    if (controller.getState().phase === 'idle') windows.dismissRecorder()
  })

  handle('recorder:open', () => {
    if (controller.getState().phase === 'idle') controller.dismissError()
    windows.openRecorder()
  })

  handle('recorder:close', () => {
    // The bar cannot be closed from under a running recording.
    if (controller.getState().phase === 'idle') windows.showLibrary()
  })

  /** Resolves a renderer-supplied session id to its screen track, if it exists. */
  async function withScreenTrack(
    sessionId: unknown,
    action: (screenPath: string) => Promise<void>
  ): Promise<IpcResult<null>> {
    if (!isSessionId(sessionId)) {
      return { ok: false, error: appError('unknown', 'invalid session id') }
    }
    try {
      const screenPath = sessions.screenPathOf(sessionId)
      await access(screenPath)
      await action(screenPath)
      return { ok: true, value: null }
    } catch (error) {
      logger.warn('could not open recording', { sessionId, error: String(error) })
      return { ok: false, error: appError('recording-invalid', String(error)) }
    }
  }
}

async function toResult<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: toAppError(error) }
  }
}

function toAppError(error: unknown): AppError {
  return error instanceof CaptureError ? error.appError : appError('unknown', String(error))
}
