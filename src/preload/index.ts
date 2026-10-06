import type { IpcRendererEvent } from 'electron'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  IpcEventChannel,
  IpcEventContract,
  IpcInvokeChannel,
  IpcInvokeContract,
  ScreenRxApi,
  Unsubscribe
} from '@shared/ipc/contract'

function invoke<Channel extends IpcInvokeChannel>(
  channel: Channel,
  ...args: IpcInvokeContract[Channel]['args']
): Promise<IpcInvokeContract[Channel]['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcInvokeContract[Channel]['result']>
}

function subscribe<Channel extends IpcEventChannel>(
  channel: Channel,
  listener: (payload: IpcEventContract[Channel]) => void
): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: IpcEventContract[Channel]): void =>
    listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * The complete surface the renderers can reach. Each entry maps to exactly
 * one channel of the IPC contract; `ipcRenderer` itself is never exposed.
 */
const api: ScreenRxApi = {
  permissions: {
    get: () => invoke('permissions:get'),
    requestScreenRecording: () => invoke('permissions:request-screen-recording'),
    openSettings: (kind) => invoke('permissions:open-settings', kind)
  },
  devices: {
    list: () => invoke('devices:list')
  },
  recording: {
    getState: () => invoke('recording:get-state'),
    setMicrophone: (deviceId) => invoke('recording:set-microphone', deviceId),
    setSystemAudio: (enabled) => invoke('recording:set-system-audio', enabled),
    setCamera: (deviceId) => invoke('recording:set-camera', deviceId),
    start: () => invoke('recording:start'),
    pause: () => invoke('recording:pause'),
    resume: () => invoke('recording:resume'),
    stop: () => invoke('recording:stop'),
    dismissError: () => invoke('recording:dismiss-error'),
    onStateChanged: (listener) => subscribe('recording:state-changed', listener)
  },
  library: {
    list: () => invoke('library:list'),
    openVideo: (sessionId) => invoke('library:open-video', sessionId),
    reveal: (sessionId) => invoke('library:reveal', sessionId),
    delete: (sessionId) => invoke('library:delete', sessionId),
    rename: (sessionId, title) => invoke('library:rename', sessionId, title),
    onChanged: (listener) => subscribe('library:changed', () => listener())
  },
  editor: {
    open: (sessionId) => invoke('editor:open', sessionId),
    saveProject: (project) => invoke('project:save', project),
    waveform: (sessionId, track) => invoke('editor:waveform', sessionId, track)
  },
  captions: {
    generate: (sessionId, request) => invoke('captions:generate', sessionId, request),
    cancel: () => invoke('captions:cancel'),
    onProgress: (listener) => subscribe('captions:progress', listener),
    translate: (request, choice) => invoke('captions:translate', request, choice)
  },
  dub: {
    status: () => invoke('dub:status'),
    prepareModel: () => invoke('dub:prepare-model'),
    removeModel: () => invoke('dub:remove-model'),
    generate: (sessionId, request) => invoke('dub:generate', sessionId, request),
    cancel: () => invoke('dub:cancel'),
    onProgress: (listener) => subscribe('dub:progress', listener)
  },
  ai: {
    providers: (refresh = false) => invoke('ai:providers', refresh),
    install: (provider) => invoke('ai:install', provider),
    login: (provider) => invoke('ai:login', provider),
    cancelSetup: () => invoke('ai:cancel-setup'),
    suggestCuts: (sessionId, choice) => invoke('ai:suggest-cuts', sessionId, choice),
    cancel: () => invoke('ai:cancel')
  },
  export: {
    start: (sessionId) => invoke('export:start', sessionId),
    readChunk: (exportId, track, offset, length) => invoke('export:read-chunk', exportId, track, offset, length),
    writeFrame: (exportId, frame) => invoke('export:write-frame', exportId, frame),
    finish: (exportId) => invoke('export:finish', exportId),
    cancel: (exportId) => invoke('export:cancel', exportId),
    reveal: (exportId) => invoke('export:reveal', exportId)
  },
  hud: {
    showSourceMenu: () => invoke('hud:show-source-menu'),
    showMicrophoneMenu: () => invoke('hud:show-microphone-menu'),
    showCameraMenu: () => invoke('hud:show-camera-menu'),
    showOptionsMenu: () => invoke('hud:show-options-menu'),
    minimize: () => invoke('hud:minimize')
  },
  recorder: {
    open: () => invoke('recorder:open'),
    close: () => invoke('recorder:close')
  }
}

contextBridge.exposeInMainWorld('screenrx', api)
