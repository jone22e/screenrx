/**
 * Timeline edits shared by every kind of region (zooms, cuts): spans of one
 * kind never overlap, never leave the recording, and never get shorter than
 * their minimum duration. Each function takes the spans sorted by start time
 * and returns the new, already constrained, span for one of them.
 */

export interface TimeSpan {
  startMs: number
  endMs: number
}

export interface IdentifiedSpan extends TimeSpan {
  id: string
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/** The free space around a span: from the end of the previous one to the start of the next. */
function roomAround(spans: readonly IdentifiedSpan[], id: string, durationMs: number): TimeSpan {
  const index = spans.findIndex((span) => span.id === id)
  return {
    startMs: spans[index - 1]?.endMs ?? 0,
    endMs: spans[index + 1]?.startMs ?? durationMs
  }
}

/** Slides a span by `deltaMs`, keeping its length, as far as its neighbours allow. */
export function moveSpan(
  spans: readonly IdentifiedSpan[],
  original: IdentifiedSpan,
  deltaMs: number,
  durationMs: number
): TimeSpan {
  const room = roomAround(spans, original.id, durationMs)
  const length = original.endMs - original.startMs
  const startMs = clamp(original.startMs + deltaMs, room.startMs, Math.max(room.startMs, room.endMs - length))
  return { startMs, endMs: startMs + length }
}

/** Drags one edge of a span to `timeMs`. */
export function resizeSpan(
  spans: readonly IdentifiedSpan[],
  original: IdentifiedSpan,
  edge: 'start' | 'end',
  timeMs: number,
  durationMs: number,
  minDurationMs: number
): TimeSpan {
  const room = roomAround(spans, original.id, durationMs)
  if (edge === 'start') {
    const latest = original.endMs - minDurationMs
    return { startMs: clamp(timeMs, room.startMs, Math.max(room.startMs, latest)), endMs: original.endMs }
  }
  const earliest = original.startMs + minDurationMs
  return { startMs: original.startMs, endMs: clamp(timeMs, Math.min(room.endMs, earliest), room.endMs) }
}

/**
 * Finds room for a new span starting at `timeMs`: the preferred length when
 * it fits, less when a neighbour is close, `null` when there is no usable gap.
 */
export function spanForNew(
  spans: readonly IdentifiedSpan[],
  timeMs: number,
  durationMs: number,
  preferredDurationMs: number,
  minDurationMs: number
): TimeSpan | null {
  if (spans.some((span) => timeMs >= span.startMs && timeMs < span.endMs)) return null
  const next = spans.find((span) => span.startMs > timeMs)
  const limit = next?.startMs ?? durationMs
  const startMs = clamp(timeMs, 0, Math.max(0, limit - minDurationMs))
  const previousEnd = Math.max(0, ...spans.filter((span) => span.endMs <= timeMs).map((span) => span.endMs))
  if (startMs < previousEnd) return null
  const endMs = Math.min(startMs + preferredDurationMs, limit)
  return endMs - startMs >= minDurationMs ? { startMs, endMs } : null
}
