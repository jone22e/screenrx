/** A backdrop for the framed recording: a linear gradient through `colors`. */
export interface BackgroundPreset {
  id: string
  name: string
  colors: readonly string[]
  angleDeg: number
}

/** The catalogue of backdrops. A project stores only the preset's id. */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: 'aurora', name: 'Aurora', colors: ['#4f7cff', '#9a6bff', '#ff7ab8'], angleDeg: 135 },
  { id: 'ocean', name: 'Oceano', colors: ['#0f2a5f', '#1c7fd6', '#56d1e8'], angleDeg: 135 },
  { id: 'sunset', name: 'Pôr do sol', colors: ['#ffb347', '#ff5e62', '#8b3dff'], angleDeg: 135 },
  { id: 'forest', name: 'Floresta', colors: ['#0f3d2e', '#1f8a5b', '#b7e36b'], angleDeg: 135 },
  { id: 'graphite', name: 'Grafite', colors: ['#3a3d47', '#15161a'], angleDeg: 160 },
  { id: 'paper', name: 'Papel', colors: ['#f6f7f9', '#d9dee7'], angleDeg: 160 }
]

export function findBackgroundPreset(presetId: string | null): BackgroundPreset | null {
  return BACKGROUND_PRESETS.find((preset) => preset.id === presetId) ?? null
}
