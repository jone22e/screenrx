import { describe, expect, it } from 'vitest'
import { parseCursorSamples, parseObjectTrack, parseObjectTrackRequest } from './telemetry'

describe('parseCursorSamples', () => {
  it('keeps the well-formed samples, in time order', () => {
    expect(parseCursorSamples([{ timeMs: 50, x: 0.2, y: 0.3 }, { timeMs: 0, x: 0.1, y: 0.1 }, { timeMs: 'x' }, null])).toEqual([
      { timeMs: 0, x: 0.1, y: 0.1 },
      { timeMs: 50, x: 0.2, y: 0.3 }
    ])
    expect(parseCursorSamples('nope')).toEqual([])
  })
})

describe('parseObjectTrack', () => {
  const track = { schemaVersion: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, startMs: 0, endMs: 500, samples: [{ timeMs: 0, x: 0.2, y: 0.2 }] }

  it('reads a track and refuses one without samples or of another version', () => {
    expect(parseObjectTrack(track)).toEqual(track)
    expect(parseObjectTrack({ ...track, samples: [] })).toBe(null)
    expect(parseObjectTrack({ ...track, schemaVersion: 2 })).toBe(null)
    expect(parseObjectTrack(null)).toBe(null)
  })
})

describe('parseObjectTrackRequest', () => {
  it('accepts a rectangle inside the frame and nothing else', () => {
    expect(parseObjectTrackRequest({ startMs: 1200, rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } })).toEqual({
      startMs: 1200,
      rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 }
    })
    expect(parseObjectTrackRequest({ startMs: 0, rect: { x: 0.4, y: 0.4, width: 0, height: 0.1 } })).toBe(null)
    expect(parseObjectTrackRequest({ startMs: 0, rect: { x: 1.2, y: 0.4, width: 0.2, height: 0.1 } })).toBe(null)
    expect(parseObjectTrackRequest({ startMs: -5, rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } })?.startMs).toBe(0)
  })
})
