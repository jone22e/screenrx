import { describe, expect, it } from 'vitest'
import { TRACK_SYNC, correctTrack } from './trackSync'

describe('correctTrack', () => {
  it('leaves a track alone within the deadband, at the base speed', () => {
    expect(correctTrack(0, 1)).toEqual({ kind: 'rate', rate: 1 })
    expect(correctTrack(0.03, 1)).toEqual({ kind: 'rate', rate: 1 })
    expect(correctTrack(-0.04, 1)).toEqual({ kind: 'rate', rate: 1 })
  })

  it('slows a track that is ahead and hurries one that is behind', () => {
    expect(correctTrack(0.1, 1)).toEqual({ kind: 'rate', rate: 1 - TRACK_SYNC.nudge })
    expect(correctTrack(-0.1, 1)).toEqual({ kind: 'rate', rate: 1 + TRACK_SYNC.nudge })
  })

  it('bends the rate around the playback speed, not around 1', () => {
    expect(correctTrack(-0.2, 2)).toEqual({ kind: 'rate', rate: 2.08 })
    expect(correctTrack(0.2, 0.5)).toEqual({ kind: 'rate', rate: 0.48 })
  })

  it('seeks only when the slip is too large to catch up by rate', () => {
    expect(correctTrack(0.5, 1)).toEqual({ kind: 'rate', rate: 1 - TRACK_SYNC.nudge })
    expect(correctTrack(0.51, 1)).toEqual({ kind: 'seek' })
    expect(correctTrack(-3, 1)).toEqual({ kind: 'seek' })
  })

  it('widens its thresholds with the speed, never narrows them below it', () => {
    // At 2x, the same slip in recording time is half as long as heard.
    expect(correctTrack(0.07, 2)).toEqual({ kind: 'rate', rate: 2 })
    expect(correctTrack(0.9, 2)).toEqual({ kind: 'rate', rate: 1.92 })
    expect(correctTrack(1.1, 2)).toEqual({ kind: 'seek' })
    // Slower than 1x keeps the 1x thresholds.
    expect(correctTrack(0.05, 0.5)).toEqual({ kind: 'rate', rate: 0.48 })
    expect(correctTrack(0.6, 0.5)).toEqual({ kind: 'seek' })
  })
})
