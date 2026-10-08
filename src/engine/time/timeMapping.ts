import type { TimelineEffect } from '@shared/models/project'

/**
 * The three time spaces of an edit, and the only place that converts
 * between them:
 *
 *   SOURCE time    position in the recording as it was captured
 *   TIMELINE time  position in the edit: source time minus the cuts, with
 *                  speed regions applied
 *   OUTPUT time    position in the exported file: timeline time divided by
 *                  the global export speed
 *
 * Effects are stored in source time. Everything else — the transport clock,
 * the exported frame times, the audio filters — is derived through here.
 */

/** A stretch of the recording that is kept, played at one speed. */
export interface TimeSegment {
  sourceStartMs: number
  sourceEndMs: number
  speed: number
  timelineStartMs: number
  timelineEndMs: number
}

export interface TimeMap {
  segments: readonly TimeSegment[]
  sourceDurationMs: number
  timelineDurationMs: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/** Builds the mapping for a recording of `sourceDurationMs` with the project's cuts and speed regions. */
export function buildTimeMap(sourceDurationMs: number, effects: readonly TimelineEffect[]): TimeMap {
  const duration = Math.max(0, sourceDurationMs)
  const within = (effect: TimelineEffect): { startMs: number; endMs: number } => ({
    startMs: clamp(effect.startMs, 0, duration),
    endMs: clamp(effect.endMs, 0, duration)
  })
  const trims = effects.filter((effect) => effect.type === 'trim').map(within)
  const speeds = effects
    .filter((effect) => effect.type === 'speed')
    .map((effect) => ({ ...within(effect), speed: effect.speed }))

  // Every boundary where "kept or cut" or the speed may change.
  const boundaries = [
    ...new Set([0, duration, ...[...trims, ...speeds].flatMap((span) => [span.startMs, span.endMs])])
  ].sort((a, b) => a - b)

  const segments: TimeSegment[] = []
  let timelineMs = 0
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const startMs = boundaries[index] as number
    const endMs = boundaries[index + 1] as number
    const middle = (startMs + endMs) / 2
    if (trims.some((trim) => middle >= trim.startMs && middle < trim.endMs)) continue
    const speed = speeds.find((region) => middle >= region.startMs && middle < region.endMs)?.speed ?? 1

    const previous = segments.at(-1)
    const length = (endMs - startMs) / speed
    if (previous && previous.sourceEndMs === startMs && previous.speed === speed) {
      segments[segments.length - 1] = {
        ...previous,
        sourceEndMs: endMs,
        timelineEndMs: previous.timelineEndMs + length
      }
    } else {
      segments.push({
        sourceStartMs: startMs,
        sourceEndMs: endMs,
        speed,
        timelineStartMs: timelineMs,
        timelineEndMs: timelineMs + length
      })
    }
    timelineMs += length
  }

  return { segments, sourceDurationMs: duration, timelineDurationMs: timelineMs }
}

/** Whether the instant survives the cuts. */
export function isSourceTimeKept(map: TimeMap, sourceMs: number): boolean {
  return map.segments.some((segment) => sourceMs >= segment.sourceStartMs && sourceMs < segment.sourceEndMs)
}

/**
 * The first kept instant at or after `sourceMs`: itself when it is kept,
 * the end of the cut it falls in otherwise, `null` past the last kept instant.
 */
export function nextKeptSourceTime(map: TimeMap, sourceMs: number): number | null {
  for (const segment of map.segments) {
    if (sourceMs < segment.sourceStartMs) return segment.sourceStartMs
    if (sourceMs < segment.sourceEndMs) return sourceMs
  }
  return null
}

/**
 * Where the playhead belongs for `sourceMs`: the instant itself when it is
 * kept, otherwise where the edit resumes after it — or, past the last kept
 * stretch, the last kept instant. `null` only when nothing at all is kept.
 */
export function keptSourceTime(map: TimeMap, sourceMs: number): number | null {
  const next = nextKeptSourceTime(map, sourceMs)
  if (next !== null) return next
  const last = map.segments[map.segments.length - 1]
  return last ? Math.max(last.sourceStartMs, last.sourceEndMs - 1) : null
}

/** A cut instant maps to where the edit resumes. */
export function sourceTimeToTimelineTime(map: TimeMap, sourceMs: number): number {
  for (const segment of map.segments) {
    if (sourceMs < segment.sourceStartMs) return segment.timelineStartMs
    if (sourceMs < segment.sourceEndMs) {
      return segment.timelineStartMs + (sourceMs - segment.sourceStartMs) / segment.speed
    }
  }
  return map.timelineDurationMs
}

export function timelineTimeToSourceTime(map: TimeMap, timelineMs: number): number {
  const time = clamp(timelineMs, 0, map.timelineDurationMs)
  for (const segment of map.segments) {
    if (time < segment.timelineEndMs) {
      return segment.sourceStartMs + (time - segment.timelineStartMs) * segment.speed
    }
  }
  return map.segments.at(-1)?.sourceEndMs ?? 0
}

/** The global export speed is a plain scaling of the whole timeline. */
export function outputTimeToTimelineTime(outputMs: number, exportSpeed: number): number {
  return outputMs * exportSpeed
}

export function timelineTimeToOutputTime(timelineMs: number, exportSpeed: number): number {
  return timelineMs / exportSpeed
}

export function outputDurationMs(map: TimeMap, exportSpeed: number): number {
  return timelineTimeToOutputTime(map.timelineDurationMs, exportSpeed)
}

export function outputTimeToSourceTime(map: TimeMap, outputMs: number, exportSpeed: number): number {
  return timelineTimeToSourceTime(map, outputTimeToTimelineTime(outputMs, exportSpeed))
}
