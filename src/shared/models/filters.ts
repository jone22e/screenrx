/**
 * Effects applied to the picture of the recording — "Efeitos" in the editor.
 *
 * Two kinds, by where they are applied:
 * - **Rendered** ones (stabilization, noise reduction, sharpening) need
 *   FFmpeg: the main process renders a derived screen track, `screen-fx.mp4`,
 *   from these settings, and the preview and the export read that track
 *   instead of the recording. The recording itself is never changed.
 * - **Colour** is applied while drawing each frame, in the preview and in the
 *   export alike, so it answers at once and needs no file.
 */

export const FILTER_STRENGTHS = ['light', 'medium', 'strong'] as const
export type FilterStrength = (typeof FILTER_STRENGTHS)[number]

export interface RenderedFilter {
  enabled: boolean
  strength: FilterStrength
}

export interface ColorSettings {
  /** 1 leaves the picture as recorded; 0.5 is half as bright, 1.5 half again. */
  brightness: number
  contrast: number
  /** 0 is black and white. */
  saturation: number
}

export interface FilterSettings {
  /** Steadies a hand-held or shaky picture (vid.stab); zooms in slightly to hide the edges it moves. */
  stabilization: RenderedFilter
  /** Softens sensor noise and compression grain (hqdn3d). */
  denoise: RenderedFilter
  /** Brings out edges (unsharp). */
  sharpen: RenderedFilter
  color: ColorSettings
}

export const COLOR_LIMITS = {
  brightness: { min: 0.5, max: 1.5 },
  contrast: { min: 0.5, max: 1.5 },
  saturation: { min: 0, max: 2 }
} as const

export const DEFAULT_COLOR: ColorSettings = { brightness: 1, contrast: 1, saturation: 1 }

export function createFilterSettings(): FilterSettings {
  return {
    stabilization: { enabled: false, strength: 'medium' },
    denoise: { enabled: false, strength: 'medium' },
    sharpen: { enabled: false, strength: 'medium' },
    color: { ...DEFAULT_COLOR }
  }
}

export type RenderedFilterName = 'stabilization' | 'denoise' | 'sharpen'
export const RENDERED_FILTERS: readonly RenderedFilterName[] = ['stabilization', 'denoise', 'sharpen']

/** Whether any effect needs the rendered track. */
export function needsRenderedTrack(settings: FilterSettings): boolean {
  return RENDERED_FILTERS.some((name) => settings[name].enabled)
}

/** Whether the colour differs from the recording's. */
export function colorChanged(color: ColorSettings): boolean {
  return color.brightness !== 1 || color.contrast !== 1 || color.saturation !== 1
}

/**
 * Identifies what a rendered track was made from: the enabled rendered
 * effects and their strengths, in a fixed order. Colour is not part of it.
 * A track whose key differs from the project's settings is stale.
 */
export function renderKey(settings: FilterSettings): string {
  return RENDERED_FILTERS.map((name) => (settings[name].enabled ? `${name}=${settings[name].strength}` : `${name}=off`)).join(';')
}

/** The rendered track, as the editor knows it: where to read it and what it was made from. */
export interface FilterTrack {
  url: string
  key: string
}

/** What the renderer asks the main process to render. */
export interface FilterRenderRequest {
  stabilization: RenderedFilter
  denoise: RenderedFilter
  sharpen: RenderedFilter
}

export interface FilterRenderProgress {
  sessionId: string
  /** 0…1 over both passes, when there are two. */
  fraction: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseRendered(value: unknown): RenderedFilter {
  const record = isRecord(value) ? value : {}
  return {
    enabled: record.enabled === true,
    strength: (FILTER_STRENGTHS as readonly unknown[]).includes(record.strength) ? (record.strength as FilterStrength) : 'medium'
  }
}

function parseColor(value: unknown): ColorSettings {
  const record = isRecord(value) ? value : {}
  const within = (raw: unknown, limits: { min: number; max: number }, fallback: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(raw, limits.min), limits.max) : fallback
  return {
    brightness: within(record.brightness, COLOR_LIMITS.brightness, 1),
    contrast: within(record.contrast, COLOR_LIMITS.contrast, 1),
    saturation: within(record.saturation, COLOR_LIMITS.saturation, 1)
  }
}

/** Lenient, like the rest of the project: anything missing or odd falls back to "as recorded". */
export function parseFilterSettings(value: unknown): FilterSettings {
  const record = isRecord(value) ? value : {}
  return {
    stabilization: parseRendered(record.stabilization),
    denoise: parseRendered(record.denoise),
    sharpen: parseRendered(record.sharpen),
    color: parseColor(record.color)
  }
}

/** Strict: a request from the renderer must name every rendered effect. */
export function parseFilterRenderRequest(value: unknown): FilterRenderRequest | null {
  if (!isRecord(value)) return null
  const request: Partial<FilterRenderRequest> = {}
  for (const name of RENDERED_FILTERS) {
    const entry = value[name]
    if (!isRecord(entry) || typeof entry.enabled !== 'boolean' || !(FILTER_STRENGTHS as readonly unknown[]).includes(entry.strength)) {
      return null
    }
    request[name] = { enabled: entry.enabled, strength: entry.strength as FilterStrength }
  }
  return request as FilterRenderRequest
}
