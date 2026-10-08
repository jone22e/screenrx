import { describe, expect, it } from 'vitest'
import { TRACK_SYNC, correctTrack } from './trackSync'

describe('correctTrack', () => {
  it('leaves a track alone within the tolerance, ahead or behind', () => {
    expect(correctTrack(0, 1)).toBe('none')
    expect(correctTrack(0.21, 1)).toBe('none')
    expect(correctTrack(-0.21, 1)).toBe('none')
    expect(correctTrack(TRACK_SYNC.toleranceS, 1)).toBe('none')
  })

  it('seeks only when the slip is beyond the tolerance', () => {
    expect(correctTrack(TRACK_SYNC.toleranceS + 0.01, 1)).toBe('seek')
    expect(correctTrack(-0.31, 1)).toBe('seek')
    expect(correctTrack(-3, 1)).toBe('seek')
  })

  it('widens the tolerance with the speed, never narrows it below 1x', () => {
    // At 2x, the same slip in recording time is half as long as heard.
    expect(correctTrack(0.5, 2)).toBe('none')
    expect(correctTrack(0.7, 2)).toBe('seek')
    expect(correctTrack(0.3, 0.5)).toBe('none')
    expect(correctTrack(0.31, 0.5)).toBe('seek')
  })
})
