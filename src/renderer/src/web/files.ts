/**
 * The browser's doors to the user's files: picking some, saving one. The
 * File System Access API (Chromium) lets a page write a file where the user
 * chooses and keep a handle to one it opened; elsewhere the page falls back
 * to `<input type=file>` and to downloads.
 */

/** A kind of file the user may pick: its MIME type and the extensions that go with it. */
export interface FileKind {
  mime: string
  extensions: string[]
}

export const VIDEO_KINDS: FileKind[] = [
  { mime: 'video/mp4', extensions: ['.mp4', '.m4v'] },
  { mime: 'video/quicktime', extensions: ['.mov'] }
]
export const IMAGE_KINDS: FileKind[] = [
  { mime: 'image/png', extensions: ['.png'] },
  { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  { mime: 'image/webp', extensions: ['.webp'] },
  { mime: 'image/gif', extensions: ['.gif'] },
  { mime: 'image/svg+xml', extensions: ['.svg'] }
]
export const AUDIO_KINDS: FileKind[] = [
  { mime: 'audio/mpeg', extensions: ['.mp3'] },
  { mime: 'audio/mp4', extensions: ['.m4a'] },
  { mime: 'audio/wav', extensions: ['.wav'] },
  { mime: 'audio/flac', extensions: ['.flac'] },
  { mime: 'audio/ogg', extensions: ['.ogg'] }
]
export const SUBTITLE_KINDS: FileKind[] = [
  { mime: 'application/x-subrip', extensions: ['.srt'] },
  { mime: 'text/vtt', extensions: ['.vtt'] }
]

interface PickerType {
  description?: string
  accept: Record<string, string[]>
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: { suggestedName?: string; types?: PickerType[] }) => Promise<FileSystemFileHandle>
    showOpenFilePicker?: (options?: { multiple?: boolean; types?: PickerType[] }) => Promise<FileSystemFileHandle[]>
  }
  interface FileSystemHandle {
    queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  }
}

/** Whether the page may keep a handle to a file the user opened, to open it again later. */
export const canKeepFileHandles = (): boolean => typeof window.showOpenFilePicker === 'function'

/** What the user chose: the files, and their handles when the browser gives them. */
export interface PickedFiles {
  files: File[]
  handles: Array<FileSystemFileHandle | null>
}

const pickerTypes = (kinds: readonly FileKind[], description: string): PickerType[] => [
  { description, accept: Object.fromEntries(kinds.map((kind) => [kind.mime, kind.extensions])) }
]

/** Whether the file is of one of the kinds, by type or, failing that, by extension. */
export function isOfKind(file: File, kinds: readonly FileKind[]): boolean {
  const name = file.name.toLowerCase()
  return kinds.some((kind) => file.type === kind.mime || kind.extensions.some((extension) => name.endsWith(extension)))
}

/** Asks for files of the given kinds. Resolves with none when the dialog is cancelled. */
export async function pickFiles(kinds: readonly FileKind[], multiple: boolean, description: string): Promise<PickedFiles> {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({ multiple, types: pickerTypes(kinds, description) })
      const files = await Promise.all(handles.map((handle) => handle.getFile()))
      return { files, handles }
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return { files: [], handles: [] }
      // The picker may be unavailable in this context (an iframe, say): the input works everywhere.
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = kinds.flatMap((kind) => [kind.mime, ...kind.extensions]).join(',')
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    const finish = (files: File[]): void => {
      input.remove()
      resolve({ files, handles: files.map(() => null) })
    }
    input.addEventListener('change', () => finish([...(input.files ?? [])]))
    input.addEventListener('cancel', () => finish([]))
    input.click()
  })
}

/** Hands the user a file to keep, by the browser's download. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // The download has taken the URL by now; releasing it at once can cancel it in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Where to write a file the user names: a handle, `null` when they cancel,
 * or `undefined` when the browser has no such dialog (the file is then
 * downloaded when done).
 */
export async function chooseSaveFile(suggestedName: string, kind: FileKind, description: string): Promise<FileSystemFileHandle | null | undefined> {
  if (!window.showSaveFilePicker) return undefined
  try {
    return await window.showSaveFilePicker({ suggestedName, types: pickerTypes([kind], description) })
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return null
    return undefined
  }
}

/** Reads a file through a handle kept from an earlier visit, asking the user's permission when needed. */
export async function fileFromHandle(handle: FileSystemFileHandle): Promise<File | null> {
  try {
    const state = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted'
    if (state !== 'granted') {
      const asked = await handle.requestPermission?.({ mode: 'read' })
      if (asked !== 'granted') return null
    }
    return await handle.getFile()
  } catch {
    return null
  }
}

/** Decodes an image file far enough to know its size; `null` when the browser cannot show it. */
export function imageSize(url: string): Promise<{ widthPx: number; heightPx: number } | null> {
  return new Promise((resolve) => {
    const picture = new Image()
    picture.onload = () => resolve({ widthPx: picture.naturalWidth, heightPx: picture.naturalHeight })
    picture.onerror = () => resolve(null)
    picture.src = url
  })
}

/** Reads the metadata of a video or audio file at `url`; `null` when the browser cannot play it. */
export function mediaMetadata(url: string, kind: 'video' | 'audio'): Promise<{ durationMs: number; widthPx: number; heightPx: number } | null> {
  return new Promise((resolve) => {
    const element = document.createElement(kind)
    element.preload = 'metadata'
    const done = (value: { durationMs: number; widthPx: number; heightPx: number } | null): void => {
      element.removeAttribute('src')
      element.load()
      resolve(value)
    }
    element.onloadedmetadata = () => {
      const durationMs = Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0
      done(
        element instanceof HTMLVideoElement
          ? { durationMs, widthPx: element.videoWidth, heightPx: element.videoHeight }
          : { durationMs, widthPx: 0, heightPx: 0 }
      )
    }
    element.onerror = () => done(null)
    element.src = url
  })
}
