import type { RecordingPhase } from '@shared/models/recording'

/** Geometry of the recording HUD, in points. */
export const HUD_LAYOUT = {
  heightPt: 62,
  /** Source, microphone, computer sound, camera, record and window controls. */
  idleWidthPt: 580,
  /** Timer, pause/resume and stop. */
  activeWidthPt: 300,
  /** Distance from the bottom of the work area on first show. */
  bottomMarginPt: 56
} as const

/** The floating camera self-view. */
export const CAMERA_BUBBLE_LAYOUT = {
  sizePt: 200,
  /** Distance from the left and bottom of the work area on first show. */
  marginPt: 32
} as const

export function hudWidthFor(phase: RecordingPhase): number {
  return phase === 'idle' || phase === 'starting' ? HUD_LAYOUT.idleWidthPt : HUD_LAYOUT.activeWidthPt
}
