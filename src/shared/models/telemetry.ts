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

/** Keeps the well-formed entries of a `cursor.json` payload, in time order. */
export function parseCursorSamples(value: unknown): CursorSample[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is CursorSample => {
      if (typeof entry !== 'object' || entry === null) return false
      const sample = entry as Partial<CursorSample>
      return Number.isFinite(sample.timeMs) && Number.isFinite(sample.x) && Number.isFinite(sample.y)
    })
    .sort((a, b) => a.timeMs - b.timeMs)
}

export const OBJECT_TRACK_SCHEMA_VERSION = 1

/** Where something the user marked in the video goes, frame by frame (`track.json`). */
export interface ObjectTrack {
  schemaVersion: typeof OBJECT_TRACK_SCHEMA_VERSION
  /** The object as marked, normalized to the frame, origin top left. */
  rect: { x: number; y: number; width: number; height: number }
  /** From when it was marked to where it was last seen. */
  startMs: number
  endMs: number
  /** The object's centre over time; positions hold until the next sample. */
  samples: CursorSample[]
}

export function parseObjectTrack(value: unknown): ObjectTrack | null {
  if (typeof value !== 'object' || value === null) return null
  const track = value as Partial<ObjectTrack>
  const rect = track.rect
  if (
    track.schemaVersion !== OBJECT_TRACK_SCHEMA_VERSION ||
    typeof rect !== 'object' ||
    rect === null ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    !Number.isFinite(track.startMs) ||
    !Number.isFinite(track.endMs)
  ) {
    return null
  }
  const samples = parseCursorSamples(track.samples)
  if (samples.length === 0) return null
  return {
    schemaVersion: OBJECT_TRACK_SCHEMA_VERSION,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    startMs: track.startMs as number,
    endMs: track.endMs as number,
    samples
  }
}

/** What to track: the object inside `rect` from `startMs` on. */
export interface ObjectTrackRequest {
  startMs: number
  rect: { x: number; y: number; width: number; height: number }
}

export function parseObjectTrackRequest(value: unknown): ObjectTrackRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const request = value as Partial<ObjectTrackRequest>
  const rect = request.rect
  if (!Number.isFinite(request.startMs) || typeof rect !== 'object' || rect === null) return null
  const within = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  if (!within(rect.x) || !within(rect.y) || !within(rect.width) || !within(rect.height) || rect.width <= 0 || rect.height <= 0) return null
  return { startMs: Math.max(0, request.startMs as number), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
}
