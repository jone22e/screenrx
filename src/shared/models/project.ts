/**
 * Project model: the non-destructive edit of one recording session.
 *
 * No media is ever rewritten by an edit: the project only stores
 * descriptions (a zoom is a time span, a focus point and a scale), and
 * rendering happens at preview/export time. It is persisted as
 * `<session>/project.json`; ephemeral UI state never goes here.
 */

/** Position in the original recording, as stored in the session's tracks. */
export type SourceMs = number & { readonly __timeSpace: 'source' }
/** Position in the edited timeline: source time after trims and speed regions. */
export type TimelineMs = number & { readonly __timeSpace: 'timeline' }
/** Position in the exported file: timeline time after the global export speed. */
export type OutputMs = number & { readonly __timeSpace: 'output' }

/** Point in a frame, normalized: (0,0) is top-left, (1,1) is bottom-right. */
export interface NormalizedPoint {
  x: number
  y: number
}

/** Every effect covers a span of SOURCE time, so edits never invalidate each other. */
interface TimelineEffectBase {
  id: string
  startMs: number
  endMs: number
}

export type ZoomEasing = 'easeInOut'

export interface ZoomEffect extends TimelineEffectBase {
  type: 'zoom'
  focus: NormalizedPoint
  scale: number
  easing: ZoomEasing
  /** `auto` zooms come from telemetry and can be regenerated; `manual` ones are the user's. */
  mode: 'auto' | 'manual'
}

/** Creative retiming of a span. Not to be confused with `ExportSettings.speed`. */
export interface SpeedEffect extends TimelineEffectBase {
  type: 'speed'
  speed: number
}

/** A span removed from the timeline. */
export interface TrimEffect extends TimelineEffectBase {
  type: 'trim'
}

/** Annotation, blur, highlight and webcam effects join this union in later phases. */
export type TimelineEffect = ZoomEffect | SpeedEffect | TrimEffect

/** Frame rates an export can be made at. */
export const EXPORT_FRAME_RATES = [24, 30, 60] as const
export type ExportFps = (typeof EXPORT_FRAME_RATES)[number]

export function isExportFps(value: unknown): value is ExportFps {
  return (EXPORT_FRAME_RATES as readonly unknown[]).includes(value)
}

export interface ExportSettings {
  format: 'mp4'
  quality: 'standard' | 'high'
  /** Frames per second of the exported file. */
  fps: ExportFps
  /**
   * Global playback speed of the exported file, applied after the whole
   * timeline: `timelineTime = outputTime * speed`. Independent of speed regions.
   */
  speed: number
}

/**
 * How the recording is framed: on a backdrop, inset by a margin, with
 * rounded corners and a shadow. Sizes are ratios of the output's shorter
 * side, so the look is the same at any resolution.
 */
export interface BackgroundSettings {
  /** A preset from the engine's catalogue, or `null` for the bare recording. */
  presetId: string | null
  paddingRatio: number
  cornerRadiusRatio: number
  shadow: boolean
}

export type WebcamShape = 'circle' | 'rounded' | 'square'
export type WebcamCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** The webcam track is never burned in; this only says how to show it. */
export interface WebcamSettings {
  visible: boolean
  shape: WebcamShape
  /** Side of the picture as a ratio of the output height. */
  sizeRatio: number
  /** Snapped to a corner, or `null` when placed freely at `position`. */
  corner: WebcamCorner | null
  /** Centre of the picture, normalized to the output; used when `corner` is `null`. */
  position: NormalizedPoint
  border: boolean
  mirrored: boolean
}

/** The audio tracks a session can have, each recorded to its own file. */
export type AudioTrackKind = 'microphone' | 'systemAudio'
export const AUDIO_TRACK_KINDS: readonly AudioTrackKind[] = ['microphone', 'systemAudio']

/** How one audio track takes part in the edit. The track itself is never changed. */
export interface AudioTrackSettings {
  /** A muted track is left out of the preview and of the exported file. */
  muted: boolean
}

export type AudioSettings = Record<AudioTrackKind, AudioTrackSettings>

/** Languages captions can be translated into. */
export type CaptionLanguage = 'en' | 'es' | 'zh' | 'pt'
export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = ['en', 'es', 'zh', 'pt']

/** One caption: a line of text shown over a span of SOURCE time. */
export interface CaptionCue {
  id: string
  startMs: number
  endMs: number
  text: string
}

export type CaptionFont = 'system' | 'rounded' | 'serif' | 'impact' | 'mono'
/** What keeps the text readable over the video. */
export type CaptionBackdrop = 'box' | 'outline' | 'shadow' | 'none'
/** How much text goes into one caption when they are built from a transcript. */
export type CaptionLength = 'short' | 'medium' | 'long'

export interface CaptionStyle {
  font: CaptionFont
  /** Font size as a ratio of the output height, so captions look the same at any resolution. */
  sizeRatio: number
  bold: boolean
  uppercase: boolean
  /** Text colour, `#rrggbb`. */
  color: string
  backdrop: CaptionBackdrop
  /** Colour of the box or of the outline, `#rrggbb`. */
  backdropColor: string
  /** Centre of the caption, normalized to the output. */
  position: NormalizedPoint
}

/**
 * Captions are drawn at preview/export time, like every other effect; the
 * cues are the user's to edit once generated from the transcript.
 */
export interface CaptionSettings {
  visible: boolean
  length: CaptionLength
  style: CaptionStyle
  /** Sorted by start time, never overlapping. Their text is in the language that was spoken. */
  cues: CaptionCue[]
  /** The language shown: a translation, or `null` for the captions as spoken. */
  language: CaptionLanguage | null
  /** Translated text of each caption, by language and then by caption id. */
  translations: Partial<Record<CaptionLanguage, Record<string, string>>>
}

export const PROJECT_SCHEMA_VERSION = 1

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  sessionId: string
  effects: TimelineEffect[]
  background: BackgroundSettings
  webcam: WebcamSettings
  captions: CaptionSettings
  audio: AudioSettings
  dub: DubSettings
  export: ExportSettings
}

/**
 * Which dubbing, if any, is heard instead of the recorded voice. The dubbing
 * tracks themselves are files of the session; this only says which one plays.
 */
export interface DubSettings {
  /** The language of the dubbing in use, or `null` for the voice as recorded. */
  language: CaptionLanguage | null
}

export const createAudioSettings = (): AudioSettings => ({
  microphone: { muted: false },
  systemAudio: { muted: false }
})

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { format: 'mp4', quality: 'high', fps: 30, speed: 1 }

export const BACKGROUND_LIMITS = { maxPaddingRatio: 0.16, maxCornerRadiusRatio: 0.05 } as const

export const WEBCAM_LIMITS = { minSizeRatio: 0.1, maxSizeRatio: 0.5 } as const

export const DEFAULT_WEBCAM: WebcamSettings = {
  visible: true,
  shape: 'circle',
  sizeRatio: 0.22,
  corner: 'bottom-right',
  position: { x: 0.5, y: 0.5 },
  border: true,
  mirrored: false
}

export const CAPTION_LIMITS = {
  minSizeRatio: 0.025,
  maxSizeRatio: 0.1,
  maxTextLength: 300,
  maxCues: 20_000
} as const

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: 'system',
  sizeRatio: 0.045,
  bold: true,
  uppercase: false,
  color: '#ffffff',
  backdrop: 'box',
  backdropColor: '#000000',
  position: { x: 0.5, y: 0.88 }
}

export function createCaptionSettings(): CaptionSettings {
  return {
    visible: true,
    length: 'medium',
    style: { ...DEFAULT_CAPTION_STYLE, position: { ...DEFAULT_CAPTION_STYLE.position } },
    cues: [],
    language: null,
    translations: {}
  }
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  presetId: 'aurora',
  paddingRatio: 0.06,
  cornerRadiusRatio: 0.014,
  shadow: true
}

export function createProject(sessionId: string, effects: TimelineEffect[] = []): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sessionId,
    effects,
    background: { ...DEFAULT_BACKGROUND },
    webcam: { ...DEFAULT_WEBCAM, position: { ...DEFAULT_WEBCAM.position } },
    captions: createCaptionSettings(),
    audio: createAudioSettings(),
    dub: { language: null },
    export: { ...DEFAULT_EXPORT_SETTINGS }
  }
}

export function trimsOf(project: Project): TrimEffect[] {
  return project.effects
    .filter((effect): effect is TrimEffect => effect.type === 'trim')
    .sort((a, b) => a.startMs - b.startMs)
}

export function zoomsOf(project: Project): ZoomEffect[] {
  return project.effects
    .filter((effect): effect is ZoomEffect => effect.type === 'zoom')
    .sort((a, b) => a.startMs - b.startMs)
}

// --- validation -------------------------------------------------------------
// Projects arrive from disk and from the renderer; neither is trusted to be
// well-formed. Parsing rebuilds each object field by field, so nothing
// unexpected is ever persisted.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const WEBCAM_SHAPES: readonly WebcamShape[] = ['circle', 'rounded', 'square']
const WEBCAM_CORNERS: readonly WebcamCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
export const CAPTION_FONT_IDS: readonly CaptionFont[] = ['system', 'rounded', 'serif', 'impact', 'mono']
const CAPTION_BACKDROPS: readonly CaptionBackdrop[] = ['box', 'outline', 'shadow', 'none']
const CAPTION_LENGTHS: readonly CaptionLength[] = ['short', 'medium', 'long']

const includes = <T>(options: readonly T[], candidate: unknown): candidate is T =>
  (options as readonly unknown[]).includes(candidate)

const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

/** Projects saved before the webcam was adjustable only say whether it is visible. */
function parseWebcam(value: unknown): WebcamSettings {
  const settings = isRecord(value) ? value : {}
  const position = isRecord(settings.position) ? settings.position : {}
  return {
    visible: settings.visible !== false,
    shape: includes(WEBCAM_SHAPES, settings.shape) ? settings.shape : DEFAULT_WEBCAM.shape,
    sizeRatio: isFiniteNumber(settings.sizeRatio)
      ? Math.min(Math.max(settings.sizeRatio, WEBCAM_LIMITS.minSizeRatio), WEBCAM_LIMITS.maxSizeRatio)
      : DEFAULT_WEBCAM.sizeRatio,
    corner:
      settings.corner === null
        ? null
        : includes(WEBCAM_CORNERS, settings.corner)
          ? settings.corner
          : DEFAULT_WEBCAM.corner,
    position: {
      x: clampRatio(position.x, DEFAULT_WEBCAM.position.x, 1),
      y: clampRatio(position.y, DEFAULT_WEBCAM.position.y, 1)
    },
    border: typeof settings.border === 'boolean' ? settings.border : DEFAULT_WEBCAM.border,
    mirrored: settings.mirrored === true
  }
}

const MAX_EFFECTS = 10_000
const MAX_ID_LENGTH = 64

const clampRatio = (value: unknown, fallback: number, max: number): number =>
  isFiniteNumber(value) ? Math.min(Math.max(value, 0), max) : fallback

/** Projects saved before framing existed simply get the defaults. */
function parseBackground(value: unknown): BackgroundSettings {
  if (!isRecord(value)) return { ...DEFAULT_BACKGROUND }
  const { presetId } = value
  return {
    presetId:
      presetId === null
        ? null
        : typeof presetId === 'string' && presetId.length <= MAX_ID_LENGTH
          ? presetId
          : DEFAULT_BACKGROUND.presetId,
    paddingRatio: clampRatio(value.paddingRatio, DEFAULT_BACKGROUND.paddingRatio, BACKGROUND_LIMITS.maxPaddingRatio),
    cornerRadiusRatio: clampRatio(
      value.cornerRadiusRatio,
      DEFAULT_BACKGROUND.cornerRadiusRatio,
      BACKGROUND_LIMITS.maxCornerRadiusRatio
    ),
    shadow: typeof value.shadow === 'boolean' ? value.shadow : DEFAULT_BACKGROUND.shadow
  }
}

/**
 * Projects saved before captions existed get the defaults. A malformed cue is
 * dropped rather than failing the project: the text can always be generated again.
 */
function parseCaptions(value: unknown): CaptionSettings {
  const settings = isRecord(value) ? value : {}
  const style = isRecord(settings.style) ? settings.style : {}
  const position = isRecord(style.position) ? style.position : {}
  const fallback = DEFAULT_CAPTION_STYLE

  const cues: CaptionCue[] = []
  const entries = Array.isArray(settings.cues) ? settings.cues.slice(0, CAPTION_LIMITS.maxCues) : []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.text !== 'string') continue
    const base = parseBase(entry)
    if (!base) continue
    // Cues never overlap: one that starts before the previous one ends is dropped.
    const previous = cues[cues.length - 1]
    if (previous && base.startMs < previous.endMs) continue
    cues.push({ ...base, text: entry.text.slice(0, CAPTION_LIMITS.maxTextLength) })
  }

  // A translation only holds text for captions that exist; a language with none left is dropped.
  const saved = isRecord(settings.translations) ? settings.translations : {}
  const translations: CaptionSettings['translations'] = {}
  for (const language of CAPTION_LANGUAGES) {
    const texts = isRecord(saved[language]) ? saved[language] : {}
    const kept: Record<string, string> = {}
    for (const cue of cues) {
      const text = texts[cue.id]
      if (typeof text === 'string') kept[cue.id] = text.slice(0, CAPTION_LIMITS.maxTextLength)
    }
    if (Object.keys(kept).length > 0) translations[language] = kept
  }
  const language =
    includes(CAPTION_LANGUAGES, settings.language) && translations[settings.language] ? settings.language : null

  return {
    visible: settings.visible !== false,
    length: includes(CAPTION_LENGTHS, settings.length) ? settings.length : 'medium',
    language,
    translations,
    style: {
      font: includes(CAPTION_FONT_IDS, style.font) ? style.font : fallback.font,
      sizeRatio: isFiniteNumber(style.sizeRatio)
        ? Math.min(Math.max(style.sizeRatio, CAPTION_LIMITS.minSizeRatio), CAPTION_LIMITS.maxSizeRatio)
        : fallback.sizeRatio,
      bold: typeof style.bold === 'boolean' ? style.bold : fallback.bold,
      uppercase: style.uppercase === true,
      color: isHexColor(style.color) ? style.color : fallback.color,
      backdrop: includes(CAPTION_BACKDROPS, style.backdrop) ? style.backdrop : fallback.backdrop,
      backdropColor: isHexColor(style.backdropColor) ? style.backdropColor : fallback.backdropColor,
      position: {
        x: clampRatio(position.x, fallback.position.x, 1),
        y: clampRatio(position.y, fallback.position.y, 1)
      }
    },
    cues
  }
}

/** Projects saved before tracks could be muted play every track. */
function parseAudio(value: unknown): AudioSettings {
  const settings = isRecord(value) ? value : {}
  const audio = createAudioSettings()
  for (const kind of AUDIO_TRACK_KINDS) {
    const track = settings[kind]
    audio[kind] = { muted: isRecord(track) && track.muted === true }
  }
  return audio
}

function parseBase(value: Record<string, unknown>): TimelineEffectBase | null {
  const { id, startMs, endMs } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) return null
  if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs) || startMs < 0 || endMs <= startMs) {
    return null
  }
  return { id, startMs, endMs }
}

function parseEffect(value: unknown): TimelineEffect | null {
  if (!isRecord(value)) return null
  const base = parseBase(value)
  if (!base) return null
  switch (value.type) {
    case 'zoom': {
      const focus = value.focus
      if (!isRecord(focus) || !isFiniteNumber(focus.x) || !isFiniteNumber(focus.y)) return null
      if (!isFiniteNumber(value.scale) || value.scale < 1) return null
      return {
        ...base,
        type: 'zoom',
        focus: { x: focus.x, y: focus.y },
        scale: value.scale,
        easing: 'easeInOut',
        mode: value.mode === 'auto' ? 'auto' : 'manual'
      }
    }
    case 'speed':
      return isFiniteNumber(value.speed) && value.speed > 0
        ? { ...base, type: 'speed', speed: value.speed }
        : null
    case 'trim':
      return { ...base, type: 'trim' }
    default:
      return null
  }
}

/** Returns a clean `Project`, or `null` when the value is not one for `sessionId`. */
export function parseProject(value: unknown, sessionId: string): Project | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION || value.sessionId !== sessionId) return null
  if (!Array.isArray(value.effects) || value.effects.length > MAX_EFFECTS) return null

  const effects: TimelineEffect[] = []
  for (const entry of value.effects) {
    const effect = parseEffect(entry)
    if (!effect) return null
    effects.push(effect)
  }

  const settings = isRecord(value.export) ? value.export : {}
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sessionId,
    effects,
    background: parseBackground(value.background),
    webcam: parseWebcam(value.webcam),
    captions: parseCaptions(value.captions),
    audio: parseAudio(value.audio),
    dub: {
      language:
        isRecord(value.dub) && includes(CAPTION_LANGUAGES, value.dub.language) ? value.dub.language : null
    },
    export: {
      format: 'mp4',
      quality: settings.quality === 'standard' ? 'standard' : 'high',
      // Projects saved before the frame rate could be chosen were exported at the default.
      fps: isExportFps(settings.fps) ? settings.fps : DEFAULT_EXPORT_SETTINGS.fps,
      speed: isFiniteNumber(settings.speed) && settings.speed > 0 ? settings.speed : 1
    }
  }
}
