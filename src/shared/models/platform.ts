/**
 * Where the renderer is running: inside the desktop app (Electron, with the
 * main process, FFmpeg and the native helpers behind it) or in a browser,
 * as the web editor. The web one has only what the browser itself offers.
 */
export type PlatformKind = 'desktop' | 'web'

/** What the web editor's server offers besides the page; the desktop has it all in the app. */
export interface PlatformServices {
  /** Speech-to-text by a transcription service the server talks to. */
  transcription: boolean
}

export interface PlatformInfo {
  kind: PlatformKind
  services: PlatformServices
}

/** What the editor may offer on a platform; everything is on for the desktop. */
export interface PlatformFeatures {
  /** Recording, the library, covers: the desktop keeps recordings; the web opens one file. */
  library: boolean
  /** The AI tools (assistant, team edit, cut suggestions, translation), which run as CLIs on the Mac. */
  ai: boolean
  /** Speech-to-text and language detection: by the native helper on the Mac, by the server's service on the web. */
  transcription: boolean
  /** Dubbing, by the native voice helper. */
  dubbing: boolean
  /** Stabilization, noise reduction and sharpening, rendered by FFmpeg into a derived track. */
  renderedEffects: boolean
  /** Following an object through the picture, by the native tracker. */
  objectTracking: boolean
  /** Dictation into the assistant's field. */
  dictation: boolean
  /** Showing an exported file in the Finder. The web saves or downloads it. */
  revealExport: boolean
}

export function featuresOf({ kind, services }: PlatformInfo): PlatformFeatures {
  const desktop = kind === 'desktop'
  return {
    library: desktop,
    ai: desktop,
    transcription: desktop || services.transcription,
    dubbing: desktop,
    renderedEffects: desktop,
    objectTracking: desktop,
    dictation: desktop,
    revealExport: desktop
  }
}
