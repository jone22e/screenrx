import type { ScreenRxApi, Unsubscribe, WaveformTrack } from '@shared/ipc/contract'
import type { EditorClip, EditorImage, MusicTrack } from '@shared/models/editor'
import { appError } from '@shared/models/errors'
import type { IpcResult } from '@shared/models/errors'
import type { PlatformServices } from '@shared/models/platform'
import { IDLE_RECORDING_STATE } from '@shared/models/recording'
import { VOICE_MODEL_DOWNLOAD_BYTES } from '@shared/models/dub'
import type { ProjectTemplate } from '@shared/models/template'
import { TEMPLATE_LIMITS, parseTemplates } from '@shared/models/template'
import { formatTimecode } from '@shared/format'
import { AUDIO_KINDS, IMAGE_KINDS, SUBTITLE_KINDS, VIDEO_KINDS, downloadBlob, imageSize, mediaMetadata, pickFiles } from './files'
import type { FileKind } from './files'
import { webSessions } from './sessions'
import { webStorage } from './storage'
import { WebExportError, WebExporter } from './webExport'
import { WebTranscriber, WebTranscriptionError } from './webTranscription'

/** Points per waveform, as the desktop draws. */
const WAVEFORM_BUCKETS = 1200
/** Waveforms are decoded at a low rate: enough for an outline, light on memory. */
const WAVEFORM_SAMPLE_RATE = 8000

const ok = <T>(value: T): IpcResult<T> => ({ ok: true, value })
const unsupported = <T>(): Promise<IpcResult<T>> => Promise.resolve({ ok: false, error: appError('web-unsupported') })
const nothing = (): Promise<void> => Promise.resolve()
const never = (): Unsubscribe => () => {}

const failing =
  <T>(work: () => Promise<T>) =>
  async (): Promise<IpcResult<T>> => {
    try {
      return ok(await work())
    } catch (error) {
      if (error instanceof WebExportError || error instanceof WebTranscriptionError) return { ok: false, error: error.appError }
      return { ok: false, error: appError('unknown', String(error)) }
    }
  }

/** The loudness outline of an audio blob, as the desktop's `audioPeaks`: `buckets` peaks between 0 and 1. */
async function audioPeaks(blob: Blob, buckets: number): Promise<number[]> {
  const context = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE)
  const buffer = await context.decodeAudioData(await blob.arrayBuffer())
  const samples = buffer.getChannelData(0)
  const peaks = new Array<number>(buckets).fill(0)
  const perBucket = Math.max(1, Math.ceil(samples.length / buckets))
  let loudest = 0
  for (let index = 0; index < samples.length; index++) {
    const bucket = Math.min(buckets - 1, Math.floor(index / perBucket))
    const value = Math.abs(samples[index] as number)
    if (value > (peaks[bucket] as number)) peaks[bucket] = value
    if (value > loudest) loudest = value
  }
  return loudest > 0 ? peaks.map((peak) => peak / loudest) : peaks
}

const waveforms = new Map<string, Promise<number[]>>()

const extensionOf = (file: File, kinds: readonly FileKind[]): string => {
  const name = file.name.toLowerCase()
  for (const kind of kinds) {
    for (const extension of kind.extensions) if (name.endsWith(extension)) return extension
  }
  return kinds.find((kind) => kind.mime === file.type)?.extensions[0] ?? ''
}

let assetCounter = 0
const assetFileName = (kind: string, extension: string): string => `${kind}-${Date.now().toString(36)}-${(assetCounter++).toString(36)}${extension}`

const exporter = new WebExporter()

/**
 * `window.screenrx` for the browser: what the preload bridge is to the
 * desktop app. The editor's own needs (the project, images, clips, music,
 * subtitle files, the export) are met with what the browser has; what
 * needs the Mac answers that it is not here, and the editor hides it (see
 * `features` in src/renderer/src/common/platform.ts).
 */
export function createWebApi(services: PlatformServices): ScreenRxApi {
  const transcriber = new WebTranscriber()
  return {
    platform: { kind: 'web', services },
    permissions: {
      get: () => unsupported(),
      requestScreenRecording: () => unsupported(),
      openSettings: nothing
    },
    devices: { list: () => unsupported() },
    recording: {
      getState: () => Promise.resolve(IDLE_RECORDING_STATE),
      setMicrophone: () => Promise.resolve(IDLE_RECORDING_STATE),
      setSystemAudio: () => Promise.resolve(IDLE_RECORDING_STATE),
      setCamera: () => Promise.resolve(IDLE_RECORDING_STATE),
      start: () => Promise.resolve(IDLE_RECORDING_STATE),
      pause: () => Promise.resolve(IDLE_RECORDING_STATE),
      resume: () => Promise.resolve(IDLE_RECORDING_STATE),
      stop: () => Promise.resolve(IDLE_RECORDING_STATE),
      dismissError: () => Promise.resolve(IDLE_RECORDING_STATE),
      onStateChanged: never
    },
    library: {
      list: () => Promise.resolve([]),
      openVideo: () => unsupported(),
      reveal: () => unsupported(),
      delete: () => unsupported(),
      rename: () => unsupported(),
      setSeries: () => unsupported(),
      chooseCover: () => unsupported(),
      setCoverFrame: () => unsupported(),
      clearCover: () => unsupported(),
      series: () => Promise.resolve([]),
      addSeries: () => unsupported(),
      removeSeries: () => unsupported(),
      renameSeries: () => unsupported(),
      planSeries: () => unsupported(),
      splitSeries: () => unsupported(),
      onSplitProgress: never,
      import: () => unsupported(),
      importFiles: () => unsupported(),
      join: () => unsupported(),
      duplicate: () => unsupported(),
      search: () => Promise.resolve([]),
      onChanged: never
    },
    editor: {
      open: (sessionId) => failing(() => webSessions.editorSession(sessionId))(),
      saveProject: (project) => failing(() => webSessions.saveProject(project).then(() => null))(),
      waveform: (sessionId, track) => failing(() => waveformOf(sessionId, track))()
    },
    captions: {
      generate: (sessionId, request) => failing(() => transcriber.generate(sessionId, request))(),
      cancel: () => {
        transcriber.cancel()
        return Promise.resolve()
      },
      detectLocale: (sessionId, track) => failing(() => transcriber.detectLocale(sessionId, track))(),
      onProgress: (listener) => transcriber.onProgress(listener),
      translate: () => unsupported(),
      exportSubtitles: (sessionId, format, content) =>
        failing(async () => {
          const video = webSessions.require(sessionId)
          const fileName = `${video.title}.${format}`
          downloadBlob(new Blob([content], { type: format === 'vtt' ? 'text/vtt' : 'application/x-subrip' }), fileName)
          return { fileName }
        })(),
      importSubtitles: () =>
        failing(async () => {
          const { files } = await pickFiles(SUBTITLE_KINDS, false, 'Legendas SRT ou WebVTT')
          const file = files[0]
          return file ? { fileName: file.name, content: await file.text() } : null
        })()
    },
    templates: {
      list: () => webStorage.readTemplates().then(parseTemplates, () => []),
      save: (template) =>
        failing(async () => {
          const templates = parseTemplates(await webStorage.readTemplates().catch(() => null))
          const next: ProjectTemplate[] = [template, ...templates.filter((known) => known.id !== template.id)].slice(0, TEMPLATE_LIMITS.maxTemplates)
          await webStorage.writeTemplates(next)
          return next
        })(),
      delete: (id) =>
        failing(async () => {
          const templates = parseTemplates(await webStorage.readTemplates().catch(() => null)).filter((known) => known.id !== id)
          await webStorage.writeTemplates(templates)
          return templates
        })()
    },
    images: {
      import: (sessionId) =>
        failing(async () => {
          const { files } = await pickFiles(IMAGE_KINDS, true, 'Imagens')
          const images: EditorImage[] = []
          for (const file of files) {
            const url = URL.createObjectURL(file)
            const size = await imageSize(url)
            URL.revokeObjectURL(url)
            if (!size) throw new WebExportError(appError('image-unsupported', file.name))
            const asset = await webSessions.addAsset(sessionId, {
              file: assetFileName('image', extensionOf(file, IMAGE_KINDS)),
              name: file.name,
              kind: 'image',
              blob: file,
              widthPx: size.widthPx,
              heightPx: size.heightPx,
              durationMs: 0
            })
            images.push({ file: asset.file, name: asset.name, url: asset.url, widthPx: asset.widthPx, heightPx: asset.heightPx })
          }
          return images
        })(),
      remove: (sessionId, file) => failing(() => webSessions.removeAsset(sessionId, file).then(() => null))()
    },
    clips: {
      import: (sessionId) =>
        failing(async () => {
          const { files } = await pickFiles(VIDEO_KINDS, true, 'Vídeos')
          return addClipFiles(sessionId, files)
        })(),
      importFiles: (sessionId, files) => failing(() => addClipFiles(sessionId, files))(),
      remove: (sessionId, file) => failing(() => webSessions.removeAsset(sessionId, file).then(() => null))()
    },
    music: {
      import: (sessionId) =>
        failing(async (): Promise<MusicTrack | null> => {
          const { files } = await pickFiles(AUDIO_KINDS, false, 'Música')
          const file = files[0]
          if (!file) return null
          const url = URL.createObjectURL(file)
          const metadata = await mediaMetadata(url, 'audio')
          URL.revokeObjectURL(url)
          if (!metadata) throw new WebExportError(appError('music-unsupported', file.name))
          // One music per session: the one before is let go.
          const video = webSessions.require(sessionId)
          for (const asset of [...video.assets.values()]) if (asset.kind === 'music') await webSessions.removeAsset(sessionId, asset.file)
          const asset = await webSessions.addAsset(sessionId, {
            file: assetFileName('music', extensionOf(file, AUDIO_KINDS)),
            name: file.name,
            kind: 'music',
            blob: file,
            widthPx: 0,
            heightPx: 0,
            durationMs: metadata.durationMs
          })
          waveforms.delete(`${sessionId}/music`)
          return { url: asset.url, durationMs: asset.durationMs, name: asset.name }
        })(),
      remove: (sessionId) =>
        failing(async () => {
          const video = webSessions.require(sessionId)
          for (const asset of [...video.assets.values()]) if (asset.kind === 'music') await webSessions.removeAsset(sessionId, asset.file)
          waveforms.delete(`${sessionId}/music`)
          return null
        })()
    },
    dub: {
      status: () => Promise.resolve({ available: false, model: 'missing', modelDownloadBytes: VOICE_MODEL_DOWNLOAD_BYTES }),
      prepareModel: () => unsupported(),
      removeModel: () => unsupported(),
      generate: () => unsupported(),
      cancel: nothing,
      onProgress: never
    },
    ai: {
      providers: () => Promise.resolve([]),
      install: () => unsupported(),
      login: () => unsupported(),
      cancelSetup: nothing,
      suggestCuts: () => unsupported(),
      assist: () => unsupported(),
      cancel: nothing,
      autoEdit: () => unsupported(),
      autoEditRerun: () => unsupported(),
      onAutoEditProgress: never,
      onAutoEditPlan: never,
      onAutoEditWorker: never
    },
    export: {
      start: (sessionId, overrides = null) => failing(() => exporter.start(sessionId, overrides))(),
      saveFrame: (sessionId, timeMs, png) =>
        failing(async () => {
          const video = webSessions.require(sessionId)
          const fileName = `${video.title} ${formatTimecode(timeMs).replace(/:/g, '.')}.png`
          downloadBlob(new Blob([new Uint8Array(png)], { type: 'image/png' }), fileName)
          return { fileName }
        })(),
      readChunk: (exportId, track, offset, length) => exporter.readChunk(exportId, track, offset, length),
      writeFrame: (exportId, frame) => failing(() => exporter.writeFrame(exportId, frame).then(() => null))(),
      finish: (exportId) => failing(() => exporter.finish(exportId))(),
      cancel: (exportId) => exporter.cancel(exportId),
      reveal: nothing
    },
    hud: {
      showSourceMenu: nothing,
      showMicrophoneMenu: nothing,
      showCameraMenu: nothing,
      showOptionsMenu: nothing,
      minimize: nothing
    },
    recorder: { open: nothing, close: nothing },
    meet: {
      getSettings: () => Promise.resolve({ baseUrl: '', token: '' }),
      saveSettings: () => unsupported(),
      listRooms: () => unsupported(),
      record: () => unsupported()
    },
    filters: {
      render: () => unsupported(),
      cancel: nothing,
      onProgress: never
    },
    track: {
      start: () => unsupported(),
      cancel: nothing,
      onProgress: never
    },
    dictation: {
      requestMicrophone: () => Promise.resolve(false),
      transcribe: () => unsupported()
    },
    update: {
      getState: () => Promise.resolve({ status: 'idle', current: __APP_VERSION__ }),
      check: () => Promise.resolve({ status: 'idle', current: __APP_VERSION__ }),
      install: () => Promise.resolve(false),
      onStateChanged: never
    },
    // Publishing and downloading by link need the Mac app's main process.
    instagram: {
      status: () => Promise.resolve({ appId: '', hasAppSecret: false, configId: '', account: null, expiresAt: null, choices: [] }),
      configure: () => unsupported(),
      login: () => unsupported(),
      connectWithToken: () => unsupported(),
      choose: () => unsupported(),
      disconnect: () => unsupported(),
      approve: () => unsupported(),
      withdraw: () => unsupported(),
      suggestCaption: () => unsupported(),
      startExport: () => unsupported(),
      mark: () => unsupported(),
      publish: () => unsupported(),
      openPost: nothing,
      onProgress: never
    },
    link: {
      status: () => Promise.resolve({ installed: false, source: null, downloadBytes: null, version: null }),
      install: () => unsupported(),
      download: () => unsupported(),
      cancel: nothing,
      onProgress: never
    }
  }
}

/** The outline of the file's own sound, or of the music; decoded once per visit. */
function waveformOf(sessionId: string, track: WaveformTrack): Promise<number[]> {
  const video = webSessions.require(sessionId)
  const blob =
    track === 'music'
      ? [...video.assets.values()].find((asset) => asset.kind === 'music')?.blob
      : track === 'microphone' && video.hasAudio
        ? video.file
        : undefined
  if (!blob) return Promise.reject(new Error(`no ${track} track`))
  const key = `${sessionId}/${track}`
  let pending = waveforms.get(key)
  if (!pending) {
    pending = audioPeaks(blob, WAVEFORM_BUCKETS)
    waveforms.set(key, pending)
    pending.catch(() => waveforms.delete(key))
  }
  return pending
}

/** Video files brought into a web session as clips. */
async function addClipFiles(sessionId: string, files: readonly File[]): Promise<EditorClip[]> {
  const clips: EditorClip[] = []
  for (const file of files) {
    const url = URL.createObjectURL(file)
    const metadata = await mediaMetadata(url, 'video')
    URL.revokeObjectURL(url)
    if (!metadata || metadata.widthPx === 0) throw new WebExportError(appError('import-unsupported', file.name))
    const asset = await webSessions.addAsset(sessionId, {
      file: assetFileName('clip', extensionOf(file, VIDEO_KINDS)),
      name: file.name,
      kind: 'clip',
      blob: file,
      widthPx: metadata.widthPx,
      heightPx: metadata.heightPx,
      durationMs: metadata.durationMs
    })
    clips.push({ file: asset.file, name: asset.name, url: asset.url, durationMs: asset.durationMs, widthPx: asset.widthPx, heightPx: asset.heightPx, hasAudio: false })
  }
  return clips
}
