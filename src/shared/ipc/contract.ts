import type { AiChoice, AiProvider, AiProviderId } from '../models/ai'
import type { AssistantReply, AssistantRequest } from '../models/assistant'
import type {
  CaptionTranslationRequest,
  Transcript,
  TranscriptionProgress,
  TranscriptionRequest,
  LocaleDetection,
  TranscriptTrack
} from '../models/captions'
import type { CaptureDevices } from '../models/devices'
import type { DubProgress, DubRequest, DubStatus, DubTrack } from '../models/dub'
import type { EditorSession } from '../models/editor'
import type { IpcResult } from '../models/errors'
import type { ExportJob, ExportResult, ExportTrackName } from '../models/export'
import type { MeetRoom, MeetSettings } from '../models/meet'
import type { PermissionKind, PermissionReport } from '../models/permissions'
import type { Project } from '../models/project'
import type { RecordingStateSnapshot } from '../models/recording'
import type { RecordingSummary } from '../models/session'
import type { CutSuggestionResult } from '../models/suggestions'
import type { UpdateState } from '../models/update'

/** An audio track whose outline the timeline can draw: a recorded one, or a dubbing. */
export type WaveformTrack = 'microphone' | 'systemAudio' | 'dubEn' | 'dubEs' | 'dubZh' | 'dubPt'

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
  'library:rename': { args: [sessionId: string, title: string]; result: IpcResult<null> }
  'library:import': { args: []; result: IpcResult<{ sessionIds: string[] }> }
  'library:import-paths': { args: [paths: string[]]; result: IpcResult<{ sessionIds: string[] }> }
  'library:search': { args: [query: string]; result: string[] }

  'editor:open': { args: [sessionId: string]; result: IpcResult<EditorSession> }
  'project:save': { args: [project: Project]; result: IpcResult<null> }
  'editor:waveform': {
    args: [sessionId: string, track: WaveformTrack]
    result: IpcResult<number[]>
  }

  'captions:generate': {
    args: [sessionId: string, request: TranscriptionRequest]
    result: IpcResult<Transcript>
  }
  'captions:cancel': { args: []; result: void }
  'captions:detect-locale': { args: [sessionId: string, track: TranscriptTrack]; result: IpcResult<LocaleDetection> }
  'captions:translate': {
    args: [request: CaptionTranslationRequest, choice: AiChoice]
    result: IpcResult<Record<string, string>>
  }

  'dub:status': { args: []; result: DubStatus }
  'dub:prepare-model': { args: []; result: IpcResult<DubStatus> }
  'dub:remove-model': { args: []; result: IpcResult<DubStatus> }
  'dub:generate': { args: [sessionId: string, request: DubRequest]; result: IpcResult<DubTrack> }
  'dub:cancel': { args: []; result: void }

  'ai:providers': { args: [refresh: boolean]; result: AiProvider[] }
  'ai:install': { args: [provider: AiProviderId]; result: IpcResult<AiProvider[]> }
  'ai:login': { args: [provider: AiProviderId]; result: IpcResult<AiProvider[]> }
  'ai:cancel-setup': { args: []; result: void }
  'ai:suggest-cuts': {
    args: [sessionId: string, choice: AiChoice]
    result: IpcResult<CutSuggestionResult>
  }
  'ai:cancel': { args: []; result: void }
  'ai:assist': {
    args: [sessionId: string, request: AssistantRequest, choice: AiChoice]
    result: IpcResult<AssistantReply>
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

  'meet:get-settings': { args: []; result: MeetSettings }
  'meet:save-settings': { args: [settings: MeetSettings]; result: IpcResult<MeetSettings> }
  'meet:list-rooms': { args: []; result: IpcResult<MeetRoom[]> }
  'meet:record': { args: [code: string]; result: IpcResult<null> }

  'dictation:request-microphone': { args: []; result: boolean }
  'dictation:transcribe': { args: [wav: Uint8Array]; result: IpcResult<{ text: string }> }

  'update:get-state': { args: []; result: UpdateState }
  'update:check': { args: []; result: UpdateState }
  'update:install': { args: []; result: boolean }
}

/** Every main → renderer broadcast. */
export interface IpcEventContract {
  'recording:state-changed': RecordingStateSnapshot
  'library:changed': null
  'captions:progress': TranscriptionProgress
  'dub:progress': DubProgress
  'update:state-changed': UpdateState
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
    /** Gives the recording a name; an empty one brings the source's label back. */
    rename(sessionId: string, title: string): Promise<IpcResult<null>>
    /**
     * Asks for video files recorded elsewhere and brings each into the library as a recording of its
     * own. Resolves with the ids imported (none when the dialog is cancelled); stops at the first
     * file that fails, after the ones before it are already in the library.
     */
    import(): Promise<IpcResult<{ sessionIds: string[] }>>
    /** Brings video files dropped on the window into the library, as `import` does for chosen ones. */
    importFiles(files: File[]): Promise<IpcResult<{ sessionIds: string[] }>>
    /** The ids of the recordings whose transcript contains the words; the title is matched by the caller. */
    search(query: string): Promise<string[]>
    onChanged(listener: () => void): Unsubscribe
  }
  editor: {
    open(sessionId: string): Promise<IpcResult<EditorSession>>
    saveProject(project: Project): Promise<IpcResult<null>>
    /** Loudness outline of an audio track: peaks between 0 and 1, evenly spaced in time. */
    waveform(sessionId: string, track: WaveformTrack): Promise<IpcResult<number[]>>
  }
  captions: {
    /**
     * Transcribes one of the session's audio tracks on this machine and stores
     * the result with the session. The audio is never uploaded.
     */
    generate(sessionId: string, request: TranscriptionRequest): Promise<IpcResult<Transcript>>
    cancel(): Promise<void>
    /** Judges from the first seconds which language the track is spoken in, among the app's languages. */
    detectLocale(sessionId: string, track: TranscriptTrack): Promise<IpcResult<LocaleDetection>>
    onProgress(listener: (progress: TranscriptionProgress) => void): Unsubscribe
    /**
     * Translates captions with the chosen AI tool and returns the translated
     * text by caption id. Only the captions' text is sent. `ai.cancel` stops it.
     */
    translate(request: CaptionTranslationRequest, choice: AiChoice): Promise<IpcResult<Record<string, string>>>
  }
  dub: {
    /** Whether this build can dub, and whether the voice model is on this machine. */
    status(): Promise<DubStatus>
    /** Downloads the voice model (once) and makes it ready. Progress comes through `onProgress`. */
    prepareModel(): Promise<IpcResult<DubStatus>>
    removeModel(): Promise<IpcResult<DubStatus>>
    /**
     * Speaks the given stretches in the speaker's own voice, cloned on this
     * machine from the microphone track, and stores the result as a track of
     * the session. Nothing is uploaded.
     */
    generate(sessionId: string, request: DubRequest): Promise<IpcResult<DubTrack>>
    /** Stops a download or a dubbing in progress. */
    cancel(): Promise<void>
    onProgress(listener: (progress: DubProgress) => void): Unsubscribe
  }
  ai: {
    /**
     * The AI command-line tools known to the app as they stand on this machine:
     * installed, signed in, models, effort levels. `refresh` looks again now.
     */
    providers(refresh?: boolean): Promise<AiProvider[]>
    /** Asks for confirmation, then installs the tool with its vendor's own installer. */
    install(provider: AiProviderId): Promise<IpcResult<AiProvider[]>>
    /** Starts the tool's own sign-in, which opens the browser, and waits for it. */
    login(provider: AiProviderId): Promise<IpcResult<AiProvider[]>>
    /** Stops an installation or a sign-in in progress. */
    cancelSetup(): Promise<void>
    /**
     * Asks an AI which stretches of speech could be cut. Only the transcript's
     * text is sent; nothing is applied — the result is a list of proposals.
     */
    suggestCuts(sessionId: string, choice: AiChoice): Promise<IpcResult<CutSuggestionResult>>
    /**
     * One message of the editing assistant's conversation. The transcript's text, the state of the
     * edit and the conversation are sent; the answer carries the edits to make. `cancel` stops it.
     */
    assist(sessionId: string, request: AssistantRequest, choice: AiChoice): Promise<IpcResult<AssistantReply>>
    cancel(): Promise<void>
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
  meet: {
    getSettings(): Promise<MeetSettings>
    saveSettings(settings: MeetSettings): Promise<IpcResult<MeetSettings>>
    /** The rooms with someone in them right now, from the meeting app. */
    listRooms(): Promise<IpcResult<MeetRoom[]>>
    /**
     * Joins the room as a recorder in a window of this app and records that
     * window with its audio. The recording bar comes up as for any recording.
     */
    record(code: string): Promise<IpcResult<null>>
  }
  dictation: {
    /** Asks macOS for the microphone, once; resolves whether the app may use it. */
    requestMicrophone(): Promise<boolean>
    /** Turns a short recording (16 kHz mono WAV) into text on this Mac; the audio is not kept. */
    transcribe(wav: Uint8Array): Promise<IpcResult<{ text: string }>>
  }
  update: {
    getState(): Promise<UpdateState>
    /** Looks for a newer version now; it downloads by itself when there is one. */
    check(): Promise<UpdateState>
    /**
     * Restarts into the downloaded version. Resolves false when there is none yet, or while a recording
     * or an export is running.
     */
    install(): Promise<boolean>
    onStateChanged(listener: (state: UpdateState) => void): Unsubscribe
  }
}
