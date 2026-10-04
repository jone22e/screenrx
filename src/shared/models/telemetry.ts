/**
 * Pointer telemetry recorded alongside the video (see Telemetry.swift).
 * Positions are normalized to the captured area: (0,0) top-left, (1,1)
 * bottom-right; values outside 0…1 are outside the recording.
 */

/** One entry of `cursor.json`. The position holds until the next sample. */
export interface CursorSample {
  timeMs: number
  x: number
  y: number
}

export type InteractionType =
  | 'mouseDown'
  | 'mouseUp'
  | 'click'
  | 'doubleClick'
  | 'rightClick'
  | 'middleClick'

export type PointerButton = 'left' | 'right' | 'middle' | 'other'

/** One entry of `interactions.json`. */
export interface InteractionEvent {
  timeMs: number
  type: InteractionType
  x: number
  y: number
  button: PointerButton
}

const INTERACTION_TYPES: ReadonlySet<string> = new Set<InteractionType>([
  'mouseDown',
  'mouseUp',
  'click',
  'doubleClick',
  'rightClick',
  'middleClick'
])

/** Keeps the well-formed entries of an `interactions.json` payload. */
export function parseInteractions(value: unknown): InteractionEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is InteractionEvent => {
    if (typeof entry !== 'object' || entry === null) return false
    const event = entry as Partial<InteractionEvent>
    return (
      Number.isFinite(event.timeMs) &&
      Number.isFinite(event.x) &&
      Number.isFinite(event.y) &&
      typeof event.type === 'string' &&
      INTERACTION_TYPES.has(event.type)
    )
  })
}
