import { describe, expect, it } from 'vitest'
import { wordsOnRecordingClock } from './ClipTranscriber'

describe('wordsOnRecordingClock', () => {
  it('moves what the clip says onto the recording, piece by piece, leaving out what no piece shows', () => {
    const words = [
      { text: 'antes', startMs: 100, endMs: 300 },
      { text: 'caramba', startMs: 600, endMs: 900 },
      { text: 'olha', startMs: 3100, endMs: 3400 },
      { text: 'depois', startMs: 9000, endMs: 9300 }
    ]
    // The clip from its 0.5 s, laid at 10 s of the recording, cut in two pieces.
    const pieces = [
      { startMs: 10_000, endMs: 12_000, offsetMs: 500 },
      { startMs: 12_000, endMs: 14_000, offsetMs: 2500 }
    ]
    expect(wordsOnRecordingClock(words, pieces)).toEqual([
      { text: 'caramba', startMs: 10_100, endMs: 10_400 },
      { text: 'olha', startMs: 12_600, endMs: 12_900 }
    ])
  })
})
