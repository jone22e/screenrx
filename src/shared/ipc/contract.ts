import type { CaptureDevices } from '../models/devices'
import type { EditorSession } from '../models/editor'
import type { IpcResult } from '../models/errors'
import type { ExportJob, ExportResult, ExportTrackName } from '../models/export'
import type { PermissionKind, PermissionReport } from '../models/permissions'
import type { Project } from '../models/project'
import type { RecordingStateSnapshot } from '../models/recording'
import type { RecordingSummary } from '../models/session'

/**
 * Every renderer → main call. The preload bridge exposes exactly these, one
 * function per channel; the renderer never gets a generic `ipcRenderer`.
 */
export interface IpcInvokeContract {
  'permissions:get': { args: []; result: IpcResult<PermissionReport> }
  'permissions:request-screen-recording': { args: []; result: IpcResult<PermissionReport> }
  'permissions:open-settings': { args: [kind: PermissionKind]; result: void }

  'devices:list': { args: []; result: IpcResult<CaptureDevices> }

  'recording:get-state': { args: []; result: RecordingStateSnapshot }
  'recording:set-microphone': { args: [deviceId: string | null]; result: RecordingStateSnapshot }
  'recording:set-system-audio': { args: [enabled: boolean]; result: RecordingStateSnapshot }
  'recording:set-camera': { args: [deviceId: string | null]; result: RecordingStateSnapshot }
  'recording:start': { args: []; result: RecordingStateSnapshot }
  'recording:pause': { args: []; result: RecordingStateSnapshot }
  'recording:resume': { args: []; result: RecordingStateSnapshot }
  'recording:stop': { args: []; result: RecordingStateSnapshot }
  'recording:dismiss-error': { args: []; result: RecordingStateSnapshot }

  'library:list': { args: []; result: RecordingSummary[] }
  'library:open-video': { args: [sessionId: string]; result: IpcResult<null> }
  'library:reveal': { args: [sessionId: string]; result: IpcResult<null> }
  'library:delete': { args: [sessionId: string]; result: IpcResult<{ deleted: boolean }> }

  'editor:open': { args: [sessionId: string]; result: IpcResult<EditorSession> }
  'project:save': { args: [project: Project]; result: IpcResult<null> }
  'editor:waveform': {
    args: [sessionId: string, track: 'microphone' | 'systemAudio']
    result: IpcResult<number[]>
  }

  'export:start': { args: [sessionId: string]; result: IpcResult<ExportJob> }
  'export:read-chunk': {
    args: [exportId: string, track: ExportTrackName, offset: number, length: number]
    result: Uint8Array
  }
  'export:write-frame': { args: [exportId: string, frame: Uint8Array]; result: IpcResult<null> }
  'export:finish': { args: [exportId: string]; result: IpcResult<ExportResult> }
  'export:cancel': { args: [exportId: string]; result: void }
  'export:reveal': { args: [exportId: string]; result: void }

  'hud:show-source-menu': { args: []; result: void }
  'hud:show-microphone-menu': { args: []; result: void }
  'hud:show-camera-menu': { args: []; result: void }
  'hud:show-options-menu': { args: []; result: void }
  'hud:minimize': { args: []; result: void }
  'recorder:open': { args: []; result: void }
  'recorder:close': { args: []; result: void }
}

/** Every main → renderer broadcast. */
export interface IpcEventContract {
  'recording:state-changed': RecordingStateSnapshot
  'library:changed': null
}

export type IpcInvokeChannel = keyof IpcInvokeContract
export type IpcEventChannel = keyof IpcEventContract

export type Unsubscribe = () => void

/** The API exposed to renderers as `window.screenrx`. */
export interface ScreenRxApi {
  permissions: {
    get(): Promise<IpcResult<PermissionReport>>
    requestScreenRecording(): Promise<IpcResult<PermissionReport>>
    openSettings(kind: PermissionKind): Promise<void>
  }
  devices: {
    list(): Promise<IpcResult<CaptureDevices>>
  }
  recording: {
    getState(): Promise<RecordingStateSnapshot>
    setMicrophone(deviceId: string | null): Promise<RecordingStateSnapshot>
    setSystemAudio(enabled: boolean): Promise<RecordingStateSnapshot>
    setCamera(deviceId: string | null): Promise<RecordingStateSnapshot>
    start(): Promise<RecordingStateSnapshot>
    pause(): Promise<RecordingStateSnapshot>
    resume(): Promise<RecordingStateSnapshot>
    stop(): Promise<RecordingStateSnapshot>
    dismissError(): Promise<RecordingStateSnapshot>
    onStateChanged(listener: (state: RecordingStateSnapshot) => void): Unsubscribe
  }
  library: {
    list(): Promise<RecordingSummary[]>
    openVideo(sessionId: string): Promise<IpcResult<null>>
    reveal(sessionId: string): Promise<IpcResult<null>>
    /** Asks for confirmation, then moves the whole recording to the system Trash. */
    delete(sessionId: string): Promise<IpcResult<{ deleted: boolean }>>
    onChanged(listener: () => void): Unsubscribe
  }
  editor: {
    open(sessionId: string): Promise<IpcResult<EditorSession>>
    saveProject(project: Project): Promise<IpcResult<null>>
    /** Loudness outline of an audio track: peaks between 0 and 1, evenly spaced in time. */
    waveform(sessionId: string, track: 'microphone' | 'systemAudio'): Promise<IpcResult<number[]>>
  }
  export: {
    /** Asks where to save and starts the encoder; the caller then renders and sends every frame. */
    start(sessionId: string): Promise<IpcResult<ExportJob>>
    readChunk(exportId: string, track: ExportTrackName, offset: number, length: number): Promise<Uint8Array>
    writeFrame(exportId: string, frame: Uint8Array): Promise<IpcResult<null>>
    finish(exportId: string): Promise<IpcResult<ExportResult>>
    cancel(exportId: string): Promise<void>
    reveal(exportId: string): Promise<void>
  }
  hud: {
    showSourceMenu(): Promise<void>
    showMicrophoneMenu(): Promise<void>
    showCameraMenu(): Promise<void>
    showOptionsMenu(): Promise<void>
    minimize(): Promise<void>
  }
  recorder: {
    /** Enters recording mode: the library hides and the recording bar appears. */
    open(): Promise<void>
    /** Leaves recording mode and returns to the library. Ignored while recording. */
    close(): Promise<void>
  }
}
