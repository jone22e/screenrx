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

export interface ExportSettings {
  format: 'mp4'
  quality: 'standard' | 'high'
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

export const PROJECT_SCHEMA_VERSION = 1

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  sessionId: string
  effects: TimelineEffect[]
  background: BackgroundSettings
  webcam: WebcamSettings
  export: ExportSettings
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { format: 'mp4', quality: 'high', speed: 1 }

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

/** Projects saved before the webcam was adjustable only say whether it is visible. */
function parseWebcam(value: unknown): WebcamSettings {
  const settings = isRecord(value) ? value : {}
  const position = isRecord(settings.position) ? settings.position : {}
  const includes = <T>(options: readonly T[], candidate: unknown): candidate is T =>
    (options as readonly unknown[]).includes(candidate)
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
    export: {
      format: 'mp4',
      quality: settings.quality === 'standard' ? 'standard' : 'high',
      speed: isFiniteNumber(settings.speed) && settings.speed > 0 ? settings.speed : 1
    }
  }
}
