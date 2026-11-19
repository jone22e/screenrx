/**
 * Project model: the non-destructive edit of one recording session.
 *
 * No media is ever rewritten by an edit: the project only stores
 * descriptions (a zoom is a time span, a focus point and a scale), and
 * rendering happens at preview/export time. It is persisted as
 * `<session>/project.json`; ephemeral UI state never goes here.
 */

import type { FilterSettings } from './filters'
import { createFilterSettings, parseFilterSettings } from './filters'

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

/** What the picture does at a cut: jumps (`cut`), or goes dark and comes back (`dip`). */
export type TrimTransition = 'cut' | 'dip'

/** A span removed from the timeline. */
export interface TrimEffect extends TimelineEffectBase {
  type: 'trim'
  /** Absent in cuts saved before transitions existed: a plain cut. */
  transition?: TrimTransition
}

/** Annotation, blur, highlight and webcam effects join this union in later phases. */
export type TimelineEffect = ZoomEffect | SpeedEffect | TrimEffect

/** A place the user marked on the recording, to find again (source time). */
export interface Marker {
  id: string
  timeMs: number
  label: string
}

export const MARKER_LIMITS = { maxMarkers: 1000, maxLabelLength: 80 } as const

/** Frame rates an export can be made at. */
export const EXPORT_FRAME_RATES = [24, 30, 60] as const
export type ExportFps = (typeof EXPORT_FRAME_RATES)[number]

export function isExportFps(value: unknown): value is ExportFps {
  return (EXPORT_FRAME_RATES as readonly unknown[]).includes(value)
}

/**
 * How hard the file is squeezed, from 0 (none: H.264 at full bitrate, which
 * plays anywhere) to 4 (the most that keeps the picture sharp: HEVC at a
 * low bitrate). The levels themselves are in the export config.
 */
export type ExportCompression = 0 | 1 | 2 | 3 | 4
export const EXPORT_COMPRESSION_LEVELS: readonly ExportCompression[] = [0, 1, 2, 3, 4]

export interface ExportSettings {
  format: 'mp4'
  quality: 'standard' | 'high'
  compression: ExportCompression
  /** Frames per second of the exported file. */
  fps: ExportFps
  /**
   * Global playback speed of the exported file, applied after the whole
   * timeline: `timelineTime = outputTime * speed`. Independent of speed regions.
   */
  speed: number
  loudness: ExportLoudness
  preset: ExportPreset
}

/**
 * How the recording is framed: on a backdrop, inset by a margin, with
 * rounded corners and a shadow. Sizes are ratios of the output's shorter
 * side, so the look is the same at any resolution.
 */
/**
 * The shape of the finished video: the recording's own, or the vertical
 * 9:16 of Reels and TikTok (two names for the same shape, kept apart so the
 * user sees the one they picked).
 */
export type FrameAspect = 'native' | '9:16' | '1:1' | '4:5'
export const FRAME_ASPECTS: readonly FrameAspect[] = ['native', '9:16', '1:1', '4:5']

/**
 * How the recording goes into a format of another shape: shrunk so all of it
 * shows (`fit`), or enlarged so it fills the frame and a part of it is used
 * (`fill`), the part being chosen with `crop`.
 */
export type FrameFit = 'fit' | 'fill' | 'follow-mouse' | 'follow-zoom' | 'follow-object'
export const FRAME_FITS: readonly FrameFit[] = ['fit', 'fill', 'follow-mouse', 'follow-zoom', 'follow-object']
/** Whether the part in use moves on its own: after the pointer, the zoom, or an object marked in the video. */
export const isFollowing = (fit: FrameFit): boolean => fit !== 'fit' && fit !== 'fill'

/** Where the recording sits in a frame taller than it, when it does not fill it. */
export type FrameAlign = 'top' | 'center' | 'bottom'
export const FRAME_ALIGNS: readonly FrameAlign[] = ['top', 'center', 'bottom']

export const FRAME_LIMITS = {
  /** Fitted: how much of the room the recording may shrink to. */
  minFitScale: 0.4,
  /** Filling: how far the part in use may be zoomed beyond what fills the frame. */
  maxFillZoom: 2
} as const

export interface BackgroundSettings {
  /** A preset from the engine's catalogue, or `null` for the bare recording. */
  presetId: string | null
  aspect: FrameAspect
  fit: FrameFit
  /** Centre of the part of the recording used when it fills the frame, normalized to the recording. */
  crop: NormalizedPoint
  /** Fitted: the recording's size as a share of what fits (≤ 1). Filling: extra zoom on the part in use (≥ 1). */
  scale: number
  /** Fitted: where the recording sits when the frame is taller than it. */
  align: FrameAlign
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
  /** How loud the track plays, 0…1; 1 is as recorded. */
  volume: number
}

export type AudioSettings = Record<AudioTrackKind, AudioTrackSettings>

/** How far the music goes down while someone speaks. */
export type MusicDucking = 'off' | 'light' | 'strong'
export const MUSIC_DUCKINGS: readonly MusicDucking[] = ['off', 'light', 'strong']

/**
 * Background music: a file the user brought into the session (`music.m4a`),
 * played under the recording on the FINISHED video's clock — it is not cut
 * or sped up with the recording. These settings only say how it plays; the
 * file itself is a track of the session.
 */
export interface MusicSettings {
  /** 0…1. */
  volume: number
  ducking: MusicDucking
  /** Starts over when it ends before the video does. */
  loop: boolean
  fadeInMs: number
  fadeOutMs: number
}

export const MUSIC_LIMITS = { maxFadeMs: 10_000 } as const

export const DEFAULT_MUSIC: MusicSettings = { volume: 0.25, ducking: 'light', loop: true, fadeInMs: 1000, fadeOutMs: 2000 }

/** Final loudness of the exported audio: as mixed, or normalized to what the social platforms expect (−14 LUFS). */
export type ExportLoudness = 'off' | 'social'

/** Where the video is going, which sets resolution, codec and frame rate and tells what the platform refuses; `custom` is by hand. */
export type ExportPreset = 'custom' | 'reels' | 'tiktok' | 'shorts' | 'youtube' | 'linkedin' | 'x'
export const EXPORT_PRESETS: readonly ExportPreset[] = ['custom', 'reels', 'tiktok', 'shorts', 'youtube', 'linkedin', 'x']
export const isExportPreset = (value: unknown): value is ExportPreset => (EXPORT_PRESETS as readonly unknown[]).includes(value)

/** Languages captions can be translated into. */
export type CaptionLanguage = 'en' | 'es' | 'zh' | 'pt'
export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = ['en', 'es', 'zh', 'pt']

/** One word of a caption and when it is spoken (source time), for the word-by-word styles. */
export interface CaptionWord {
  text: string
  startMs: number
  endMs: number
}

/** One caption: a line of text shown over a span of SOURCE time. */
export interface CaptionCue {
  id: string
  startMs: number
  endMs: number
  text: string
  /**
   * The words of `text`, in order, each with its own time. Always one per
   * space-separated word of `text`; spread evenly when the real timing is
   * unknown (a caption typed by hand, an older project).
   */
  words: CaptionWord[]
}

export type CaptionFont = 'system' | 'rounded' | 'serif' | 'impact' | 'mono' | 'cursive'
/** What keeps the text readable over the video. */
export type CaptionBackdrop = 'box' | 'outline' | 'shadow' | 'none'
/**
 * How much text goes into one caption when they are built from a transcript:
 * `word` is one word at a time, `pair` two or three, the others fill a line.
 */
export type CaptionLength = 'word' | 'pair' | 'short' | 'medium' | 'long'
/**
 * How the words of a caption are drawn as they are spoken: all alike (`block`),
 * the spoken one in the highlight colour (`highlight`), or appearing one by one
 * as they are said (`reveal`).
 */
export type CaptionMode = 'block' | 'highlight' | 'reveal'
/** How a caption comes on screen. */
export type CaptionAnimation = 'none' | 'pop' | 'fade'

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
  mode: CaptionMode
  /** Colour of the word being spoken in the `highlight` and `reveal` modes, `#rrggbb`. */
  highlightColor: string
  animation: CaptionAnimation
}

/** Words of `text` spread evenly over `startMs`–`endMs`: the timing used when the real one is unknown. */
export function spreadWords(text: string, startMs: number, endMs: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter((token) => token !== '')
  const step = (endMs - startMs) / Math.max(tokens.length, 1)
  return tokens.map((token, index) => ({
    text: token,
    startMs: startMs + index * step,
    endMs: index === tokens.length - 1 ? endMs : startMs + (index + 1) * step
  }))
}

/** How a text comes on or goes off screen. */
export type TextMotionKind = 'none' | 'fade' | 'pop' | 'slide-up'
export const TEXT_MOTION_KINDS: readonly TextMotionKind[] = ['none', 'fade', 'pop', 'slide-up']

export interface TextMotion {
  kind: TextMotionKind
  durationMs: number
}

export const DEFAULT_TEXT_MOTION: TextMotion = { kind: 'none', durationMs: 300 }
export const TEXT_MOTION_LIMITS = { maxDurationMs: 2000 } as const

/**
 * A text the user writes over the video — a title, a call-out — shown during
 * its span, in a look of its own, with an entrance and an exit. Texts may
 * overlap in time.
 */
export interface TextOverlay {
  id: string
  startMs: number
  endMs: number
  text: string
  style: CaptionStyle
  enter: TextMotion
  exit: TextMotion
}

/** What every layer over the video shares: when it shows, where it sits, how big, turned and faded. */
export interface LayerPlacement {
  id: string
  startMs: number
  endMs: number
  /** Centre of the layer, normalized to the output. */
  position: NormalizedPoint
  /** Width as a ratio of the output width; the height follows the layer's own proportions. */
  sizeRatio: number
  rotationDeg: number
  /** 0…1. */
  opacity: number
  /** Corner rounding as a ratio of the layer's shorter side; 0.5 makes a square round. */
  cornerRadiusRatio: number
}

/**
 * An image laid over the video — a logo, a sticker, a screenshot — during
 * its span. The file is one of the session's `assets/`; the layer only says
 * how and when it shows. Layers are drawn in list order, the last on top.
 */
export interface ImageLayer extends LayerPlacement {
  kind: 'image'
  /** File name inside the session's `assets/` folder. */
  file: string
}

/**
 * A clip of video laid over the recording (b-roll) during its span, placed
 * like an image. It plays from `offsetMs` into the clip, forward with the
 * recording, without its own sound.
 */
export interface VideoLayer extends LayerPlacement {
  kind: 'video'
  file: string
  /** Where in the clip it starts playing, in ms. */
  offsetMs: number
  /** Split screen with the recording while the layer is on, instead of floating over it; absent: floating. */
  split?: SplitScreen
}

/** `stacked`: one above the other (the Reels look); `side`: side by side. */
export type SplitOrientation = 'stacked' | 'side'
/** Whose sound is heard while the screen is split. */
export type SplitAudio = 'main' | 'clip' | 'both'
/** What the frame shows during the stretch: both videos split, only the recording, or only the clip (a reaction's big moment). */
export type SplitShow = 'both' | 'main' | 'clip'
export const SPLIT_SHOWS: readonly SplitShow[] = ['both', 'main', 'clip']

/**
 * The recording and a clip sharing the frame, each filling its part (cut to
 * its shape, never squeezed), with a line between them. Only during the
 * clip layer's span; before and after, the recording has the frame alone.
 */
export interface SplitScreen {
  orientation: SplitOrientation
  /** The clip on top (or on the left); otherwise the recording is. */
  clipFirst: boolean
  /** The recording's share of the frame along the split, 0.2–0.8. */
  mainShare: number
  /** Centre of the part of the clip shown, normalized to the clip. */
  clipFocus: NormalizedPoint
  /** Centre of the part of the recording shown, normalized to the recording. */
  mainFocus: NormalizedPoint
  /** Thickness of the line between the two, as a ratio of the output's shorter side; 0 for none. */
  dividerRatio: number
  /** `#rrggbb`. */
  dividerColor: string
  audio: SplitAudio
  /** The clip's sound, when heard. */
  clipVolume: number
  /** What the frame shows meanwhile; the sound goes on as set whichever is shown. Absent: both. */
  show?: SplitShow
}

export const SPLIT_LIMITS = { minShare: 0.2, maxShare: 0.8, maxDividerRatio: 0.03, maxClipVolume: 2 } as const

export const DEFAULT_SPLIT: SplitScreen = {
  orientation: 'stacked',
  clipFirst: false,
  mainShare: 0.5,
  clipFocus: { x: 0.5, y: 0.5 },
  mainFocus: { x: 0.5, y: 0.5 },
  dividerRatio: 0.004,
  dividerColor: '#000000',
  audio: 'both',
  clipVolume: 1
}

/** A split read back, checked; `undefined` when there is none (the layer floats). */
export function parseSplitScreen(value: unknown): SplitScreen | undefined {
  if (!isRecord(value)) return undefined
  const share = isFiniteNumber(value.mainShare) ? Math.min(Math.max(value.mainShare, SPLIT_LIMITS.minShare), SPLIT_LIMITS.maxShare) : DEFAULT_SPLIT.mainShare
  return {
    orientation: value.orientation === 'side' ? 'side' : 'stacked',
    clipFirst: value.clipFirst === true,
    mainShare: share,
    clipFocus: parseNormalizedPoint(value.clipFocus, DEFAULT_SPLIT.clipFocus),
    mainFocus: parseNormalizedPoint(value.mainFocus, DEFAULT_SPLIT.mainFocus),
    dividerRatio: clampRatio(value.dividerRatio, DEFAULT_SPLIT.dividerRatio, SPLIT_LIMITS.maxDividerRatio),
    dividerColor: isHexColor(value.dividerColor) ? value.dividerColor : DEFAULT_SPLIT.dividerColor,
    audio: value.audio === 'main' || value.audio === 'clip' ? value.audio : 'both',
    clipVolume: clampRatio(value.clipVolume, 1, SPLIT_LIMITS.maxClipVolume),
    ...(value.show === 'main' || value.show === 'clip' ? { show: value.show } : {})
  }
}

export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'arrow' | 'line' | 'star' | 'heart'
export const SHAPE_KINDS: readonly ShapeKind[] = ['rectangle', 'ellipse', 'triangle', 'diamond', 'arrow', 'line', 'star', 'heart']

/**
 * A shape drawn over the video — a box around a button, an arrow, a bar —
 * filled, outlined or both. It needs no file: it is drawn from its settings.
 */
export interface ShapeLayer extends LayerPlacement {
  kind: 'shape'
  shape: ShapeKind
  /** Height as a ratio of the width. */
  aspect: number
  fill: boolean
  /** `#rrggbb`. */
  fillColor: string
  /** Thickness of the outline as a ratio of the output height; 0 for none. */
  strokeRatio: number
  /** `#rrggbb`. */
  strokeColor: string
}

/** An emoji drawn over the video, in the system's emoji font, as big as asked. */
export interface EmojiLayer extends LayerPlacement {
  kind: 'emoji'
  /** One emoji (a single grapheme, which may be several code points). */
  emoji: string
}

export type Layer = ImageLayer | VideoLayer | ShapeLayer | EmojiLayer
/** The layers that show a file of the session. */
export type FileLayer = ImageLayer | VideoLayer
/** The layers drawn from their settings alone, with no file. */
export type ElementLayer = ShapeLayer | EmojiLayer

export const isFileLayer = (layer: Layer): layer is FileLayer => layer.kind === 'image' || layer.kind === 'video'
export const isElementLayer = (layer: Layer): layer is ElementLayer => layer.kind === 'shape' || layer.kind === 'emoji'

/** How steady the drawn pointer's hand is. */
export type CursorSmoothing = 'none' | 'light' | 'strong'
export const CURSOR_SMOOTHINGS: readonly CursorSmoothing[] = ['none', 'light', 'strong']

/**
 * The pointer as drawn from its telemetry, for recordings made without the
 * system cursor in the picture: an arrow that scales with the zoom, and a
 * ring on every click.
 */
export interface CursorSettings {
  visible: boolean
  /** Height of the arrow as a ratio of the frame's height, before the zoom. */
  sizeRatio: number
  clickHighlight: boolean
  smoothing: CursorSmoothing
}

export const CURSOR_LIMITS = { minSizeRatio: 0.015, maxSizeRatio: 0.1 } as const

export const DEFAULT_CURSOR: CursorSettings = { visible: true, sizeRatio: 0.035, clickHighlight: true, smoothing: 'light' }

export const LAYER_LIMITS = {
  maxLayers: 200,
  minSizeRatio: 0.02,
  maxSizeRatio: 1.5,
  maxCornerRadiusRatio: 0.5,
  minDurationMs: 300
} as const

export const DEFAULT_IMAGE_LAYER: Pick<ImageLayer, 'position' | 'sizeRatio' | 'rotationDeg' | 'opacity' | 'cornerRadiusRatio'> = {
  position: { x: 0.85, y: 0.12 },
  sizeRatio: 0.18,
  rotationDeg: 0,
  opacity: 1,
  cornerRadiusRatio: 0
}

export const SHAPE_LIMITS = {
  minAspect: 0.04,
  maxAspect: 3,
  maxStrokeRatio: 0.03,
  /** How long a shape or an emoji shows when added, before it is trimmed on the timeline. */
  defaultDurationMs: 3000,
  maxEmojiLength: 32
} as const

/** A shape as added: solid, centred, no outline; each kind then gets its own proportions. */
export const DEFAULT_SHAPE_LAYER: Pick<ShapeLayer, 'position' | 'sizeRatio' | 'rotationDeg' | 'opacity' | 'cornerRadiusRatio' | 'aspect' | 'fill' | 'fillColor' | 'strokeRatio' | 'strokeColor'> = {
  position: { x: 0.5, y: 0.5 },
  sizeRatio: 0.2,
  rotationDeg: 0,
  opacity: 1,
  cornerRadiusRatio: 0,
  aspect: 1,
  fill: true,
  fillColor: '#ff3b30',
  strokeRatio: 0,
  strokeColor: '#ffffff'
}

export const DEFAULT_EMOJI_LAYER: Pick<EmojiLayer, 'position' | 'sizeRatio' | 'rotationDeg' | 'opacity' | 'cornerRadiusRatio'> = {
  position: { x: 0.5, y: 0.5 },
  sizeRatio: 0.1,
  rotationDeg: 0,
  opacity: 1,
  cornerRadiusRatio: 0
}

export const TEXT_LIMITS = {
  maxTexts: 500,
  maxTextLength: 300,
  defaultDurationMs: 3000,
  minDurationMs: 300
} as const

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
  /** Texts written over the video. Empty in projects saved before they existed. */
  texts: TextOverlay[]
  /** Images over the video, bottom first. Empty in projects saved before them. */
  layers: Layer[]
  /** The drawn pointer; ignored by recordings that have the system cursor in the picture. */
  cursor: CursorSettings
  audio: AudioSettings
  /** How the session's music track plays; `null` until music is brought in (the file may still be there). */
  music: MusicSettings | null
  /** Places marked on the recording, sorted by time. Empty in projects saved before them. */
  markers: Marker[]
  dub: DubSettings
  /** Effects on the picture: stabilization, noise reduction, sharpening, colour. */
  filters: FilterSettings
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
  microphone: { muted: false, volume: 1 },
  systemAudio: { muted: false, volume: 1 }
})

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'mp4',
  quality: 'high',
  compression: 0,
  fps: 30,
  speed: 1,
  loudness: 'social',
  preset: 'custom'
}

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
  position: { x: 0.5, y: 0.88 },
  mode: 'block',
  highlightColor: '#ffe14d',
  animation: 'none'
}

/** A new text: big, in the middle of the frame, with a shadow so it reads over anything. */
export const DEFAULT_TEXT_STYLE: CaptionStyle = {
  ...DEFAULT_CAPTION_STYLE,
  sizeRatio: 0.07,
  backdrop: 'shadow',
  position: { x: 0.5, y: 0.5 }
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
  presetId: null,
  aspect: 'native',
  fit: 'fit',
  crop: { x: 0.5, y: 0.5 },
  scale: 1,
  align: 'center',
  paddingRatio: 0.06,
  cornerRadiusRatio: 0.014,
  shadow: true
}

export const isFrameAspect = (value: unknown): value is FrameAspect => (FRAME_ASPECTS as readonly unknown[]).includes(value)

export function createProject(sessionId: string, effects: TimelineEffect[] = []): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sessionId,
    effects,
    background: { ...DEFAULT_BACKGROUND },
    webcam: { ...DEFAULT_WEBCAM, position: { ...DEFAULT_WEBCAM.position } },
    captions: createCaptionSettings(),
    texts: [],
    layers: [],
    cursor: { ...DEFAULT_CURSOR },
    audio: createAudioSettings(),
    music: null,
    markers: [],
    dub: { language: null },
    filters: createFilterSettings(),
    export: { ...DEFAULT_EXPORT_SETTINGS }
  }
}

export function trimsOf(project: Project): TrimEffect[] {
  return project.effects
    .filter((effect): effect is TrimEffect => effect.type === 'trim')
    .sort((a, b) => a.startMs - b.startMs)
}

export function speedsOf(project: Project): SpeedEffect[] {
  return project.effects
    .filter((effect): effect is SpeedEffect => effect.type === 'speed')
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
export const CAPTION_FONT_IDS: readonly CaptionFont[] = ['system', 'rounded', 'serif', 'impact', 'mono', 'cursive']
const CAPTION_BACKDROPS: readonly CaptionBackdrop[] = ['box', 'outline', 'shadow', 'none']
export const CAPTION_LENGTHS: readonly CaptionLength[] = ['word', 'pair', 'short', 'medium', 'long']
export const CAPTION_MODES: readonly CaptionMode[] = ['block', 'highlight', 'reveal']
export const CAPTION_ANIMATIONS: readonly CaptionAnimation[] = ['none', 'pop', 'fade']

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

function parseNormalizedPoint(value: unknown, fallback: NormalizedPoint): NormalizedPoint {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return { ...fallback }
  return { x: Math.min(Math.max(value.x, 0), 1), y: Math.min(Math.max(value.y, 0), 1) }
}

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
    // The first vertical formats were named after the networks.
    aspect: includes(FRAME_ASPECTS, value.aspect)
      ? value.aspect
      : value.aspect === 'reels' || value.aspect === 'tiktok'
        ? '9:16'
        : DEFAULT_BACKGROUND.aspect,
    // The first "follow" followed the zoom.
    fit: includes(FRAME_FITS, value.fit) ? value.fit : value.fit === 'follow' ? 'follow-zoom' : DEFAULT_BACKGROUND.fit,
    crop: parseNormalizedPoint(value.crop, DEFAULT_BACKGROUND.crop),
    scale: isFiniteNumber(value.scale) ? Math.min(Math.max(value.scale, FRAME_LIMITS.minFitScale), FRAME_LIMITS.maxFillZoom) : DEFAULT_BACKGROUND.scale,
    align: includes(FRAME_ALIGNS, value.align) ? value.align : DEFAULT_BACKGROUND.align,
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
    const text = entry.text.slice(0, CAPTION_LIMITS.maxTextLength)
    cues.push({ ...base, text, words: parseWords(entry.words, text, base) })
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
    style: parseStyle(settings.style, fallback),
    cues
  }
}

/** A text look as saved; whatever is not well-formed takes the fallback's value. */
function parseStyle(value: unknown, fallback: CaptionStyle): CaptionStyle {
  const style = isRecord(value) ? value : {}
  const position = isRecord(style.position) ? style.position : {}
  return {
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
    },
    mode: includes(CAPTION_MODES, style.mode) ? style.mode : fallback.mode,
    highlightColor: isHexColor(style.highlightColor) ? style.highlightColor : fallback.highlightColor,
    animation: includes(CAPTION_ANIMATIONS, style.animation) ? style.animation : fallback.animation
  }
}

/**
 * The words of a saved caption, when they match its text and stay inside its
 * span; otherwise the text's words spread evenly, which is always usable.
 */
function parseWords(value: unknown, text: string, span: { startMs: number; endMs: number }): CaptionWord[] {
  const tokens = text.split(/\s+/).filter((token) => token !== '')
  if (Array.isArray(value) && value.length === tokens.length) {
    const words: CaptionWord[] = []
    let previousStart = span.startMs
    for (const [index, entry] of value.entries()) {
      if (!isRecord(entry) || !isFiniteNumber(entry.startMs) || !isFiniteNumber(entry.endMs)) break
      if (entry.startMs < previousStart || entry.endMs < entry.startMs || entry.endMs > span.endMs) break
      words.push({ text: tokens[index] as string, startMs: entry.startMs, endMs: entry.endMs })
      previousStart = entry.startMs
    }
    if (words.length === tokens.length) return words
  }
  return spreadWords(text, span.startMs, span.endMs)
}

/** Texts over the video, sorted by start; they may overlap. Projects saved before them have none. */
function parseTexts(value: unknown): TextOverlay[] {
  const texts: TextOverlay[] = []
  for (const entry of Array.isArray(value) ? value.slice(0, TEXT_LIMITS.maxTexts) : []) {
    if (!isRecord(entry) || typeof entry.text !== 'string') continue
    const base = parseBase(entry)
    if (!base) continue
    texts.push({
      ...base,
      text: entry.text.slice(0, TEXT_LIMITS.maxTextLength),
      style: parseStyle(entry.style, DEFAULT_TEXT_STYLE),
      enter: parseMotion(entry.enter),
      exit: parseMotion(entry.exit)
    })
  }
  return texts.sort((a, b) => a.startMs - b.startMs)
}

/** A text's entrance or exit as saved; texts saved before them come and go at once. */
function parseMotion(value: unknown): TextMotion {
  const motion = isRecord(value) ? value : {}
  return {
    kind: includes(TEXT_MOTION_KINDS, motion.kind) ? motion.kind : DEFAULT_TEXT_MOTION.kind,
    durationMs: clampRatio(motion.durationMs, DEFAULT_TEXT_MOTION.durationMs, TEXT_MOTION_LIMITS.maxDurationMs)
  }
}

/** The drawn pointer's settings as saved; projects saved before them get the default. */
function parseCursor(value: unknown): CursorSettings {
  const settings = isRecord(value) ? value : {}
  return {
    visible: settings.visible !== false,
    sizeRatio: isFiniteNumber(settings.sizeRatio)
      ? Math.min(Math.max(settings.sizeRatio, CURSOR_LIMITS.minSizeRatio), CURSOR_LIMITS.maxSizeRatio)
      : DEFAULT_CURSOR.sizeRatio,
    clickHighlight: settings.clickHighlight !== false,
    smoothing: includes(CURSOR_SMOOTHINGS, settings.smoothing) ? settings.smoothing : DEFAULT_CURSOR.smoothing
  }
}

/** Layers as saved, in their order; a malformed one is dropped. Projects saved before them have none. */
function parseLayers(value: unknown): Layer[] {
  const layers: Layer[] = []
  for (const entry of Array.isArray(value) ? value.slice(0, LAYER_LIMITS.maxLayers) : []) {
    if (!isRecord(entry)) continue
    const base = parseBase(entry)
    if (!base) continue
    const placement = (fallback: Pick<LayerPlacement, 'position' | 'sizeRatio'>): LayerPlacement => ({
      ...base,
      position: parseNormalizedPoint(entry.position, fallback.position),
      sizeRatio: isFiniteNumber(entry.sizeRatio) ? Math.min(Math.max(entry.sizeRatio, LAYER_LIMITS.minSizeRatio), LAYER_LIMITS.maxSizeRatio) : fallback.sizeRatio,
      rotationDeg: isFiniteNumber(entry.rotationDeg) ? ((entry.rotationDeg % 360) + 360) % 360 : 0,
      opacity: clampRatio(entry.opacity, 1, 1),
      cornerRadiusRatio: clampRatio(entry.cornerRadiusRatio, 0, LAYER_LIMITS.maxCornerRadiusRatio)
    })
    switch (entry.kind) {
      case 'image':
      case 'video': {
        if (typeof entry.file !== 'string' || !/^[^/\\\0]{1,255}$/.test(entry.file) || entry.file === '.' || entry.file === '..') continue
        const common = { ...placement(DEFAULT_IMAGE_LAYER), file: entry.file }
        layers.push(
          entry.kind === 'video'
            ? {
                ...common,
                kind: 'video',
                offsetMs: isFiniteNumber(entry.offsetMs) && entry.offsetMs >= 0 ? entry.offsetMs : 0,
                ...(parseSplitScreen(entry.split) && { split: parseSplitScreen(entry.split) as SplitScreen })
              }
            : { ...common, kind: 'image' }
        )
        break
      }
      case 'shape':
        if (!includes(SHAPE_KINDS, entry.shape)) continue
        layers.push({
          ...placement(DEFAULT_SHAPE_LAYER),
          kind: 'shape',
          shape: entry.shape,
          aspect: isFiniteNumber(entry.aspect) ? Math.min(Math.max(entry.aspect, SHAPE_LIMITS.minAspect), SHAPE_LIMITS.maxAspect) : DEFAULT_SHAPE_LAYER.aspect,
          fill: entry.fill !== false,
          fillColor: isHexColor(entry.fillColor) ? entry.fillColor : DEFAULT_SHAPE_LAYER.fillColor,
          strokeRatio: clampRatio(entry.strokeRatio, DEFAULT_SHAPE_LAYER.strokeRatio, SHAPE_LIMITS.maxStrokeRatio),
          strokeColor: isHexColor(entry.strokeColor) ? entry.strokeColor : DEFAULT_SHAPE_LAYER.strokeColor
        })
        break
      case 'emoji': {
        const emoji = typeof entry.emoji === 'string' ? entry.emoji.trim().slice(0, SHAPE_LIMITS.maxEmojiLength) : ''
        if (emoji === '') continue
        layers.push({ ...placement(DEFAULT_EMOJI_LAYER), kind: 'emoji', emoji })
        break
      }
      default:
        continue
    }
  }
  return layers
}

/** Projects saved before tracks could be muted play every track; before they had a volume, at full volume. */
function parseAudio(value: unknown): AudioSettings {
  const settings = isRecord(value) ? value : {}
  const audio = createAudioSettings()
  for (const kind of AUDIO_TRACK_KINDS) {
    const track = isRecord(settings[kind]) ? settings[kind] : {}
    audio[kind] = { muted: track.muted === true, volume: clampRatio(track.volume, 1, 1) }
  }
  return audio
}

/** Markers as saved, sorted; a malformed one is dropped. Projects saved before them have none. */
function parseMarkers(value: unknown): Marker[] {
  const markers: Marker[] = []
  for (const entry of Array.isArray(value) ? value.slice(0, MARKER_LIMITS.maxMarkers) : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '' || entry.id.length > MAX_ID_LENGTH) continue
    if (!isFiniteNumber(entry.timeMs) || entry.timeMs < 0) continue
    const label = typeof entry.label === 'string' ? entry.label.replace(/\s+/g, ' ').trim().slice(0, MARKER_LIMITS.maxLabelLength) : ''
    markers.push({ id: entry.id, timeMs: entry.timeMs, label })
  }
  return markers.sort((a, b) => a.timeMs - b.timeMs)
}

/** Music settings as saved; whatever is not well-formed takes the default. `null` when there are none. */
function parseMusic(value: unknown): MusicSettings | null {
  if (!isRecord(value)) return null
  return {
    volume: clampRatio(value.volume, DEFAULT_MUSIC.volume, 1),
    ducking: includes(MUSIC_DUCKINGS, value.ducking) ? value.ducking : DEFAULT_MUSIC.ducking,
    loop: typeof value.loop === 'boolean' ? value.loop : DEFAULT_MUSIC.loop,
    fadeInMs: clampRatio(value.fadeInMs, DEFAULT_MUSIC.fadeInMs, MUSIC_LIMITS.maxFadeMs),
    fadeOutMs: clampRatio(value.fadeOutMs, DEFAULT_MUSIC.fadeOutMs, MUSIC_LIMITS.maxFadeMs)
  }
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
      return { ...base, type: 'trim', transition: value.transition === 'dip' ? 'dip' : 'cut' }
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

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sessionId,
    effects,
    background: parseBackground(value.background),
    webcam: parseWebcam(value.webcam),
    captions: parseCaptions(value.captions),
    texts: parseTexts(value.texts),
    layers: parseLayers(value.layers),
    cursor: parseCursor(value.cursor),
    audio: parseAudio(value.audio),
    music: parseMusic(value.music),
    markers: parseMarkers(value.markers),
    dub: {
      language:
        isRecord(value.dub) && includes(CAPTION_LANGUAGES, value.dub.language) ? value.dub.language : null
    },
    filters: parseFilterSettings(value.filters),
    export: parseExportSettings(value.export)
  }
}

/** Export settings as saved; whatever is not well-formed takes the default. */
export function parseExportSettings(value: unknown): ExportSettings {
  const settings = isRecord(value) ? value : {}
  return {
    format: 'mp4',
    quality: settings.quality === 'standard' ? 'standard' : 'high',
    // The first version of this was 'normal' | 'compact'.
    compression: includes(EXPORT_COMPRESSION_LEVELS, settings.compression)
      ? settings.compression
      : settings.compression === 'compact'
        ? 2
        : DEFAULT_EXPORT_SETTINGS.compression,
    // Projects saved before the frame rate could be chosen were exported at the default.
    fps: isExportFps(settings.fps) ? settings.fps : DEFAULT_EXPORT_SETTINGS.fps,
    speed: isFiniteNumber(settings.speed) && settings.speed > 0 ? settings.speed : 1,
    // Projects saved before the loudness could be chosen go out as they were mixed.
    loudness: settings.loudness === 'social' ? 'social' : 'off',
    preset: isExportPreset(settings.preset) ? settings.preset : 'custom'
  }
}
