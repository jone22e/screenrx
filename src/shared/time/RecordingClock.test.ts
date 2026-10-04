import { describe, expect, it } from 'vitest'
import { RecordingClock } from './RecordingClock'

function createClock(): { clock: RecordingClock; advance: (ms: number) => void } {
  let now = 1_000
  return {
    clock: new RecordingClock(() => now),
    advance: (ms) => {
      now += ms
    }
  }
}

describe('RecordingClock', () => {
  it('reports zero before it starts', () => {
    const { clock } = createClock()
    expect(clock.currentTimeMs()).toBe(0)
    expect(clock.snapshot().state).toBe('idle')
  })

  it('advances with the time source while running', () => {
    const { clock, advance } = createClock()
    clock.start()
    advance(2_500)
    expect(clock.currentTimeMs()).toBe(2_500)
    expect(clock.isRunning).toBe(true)
  })

  it('freezes while paused and excludes the paused span after resuming', () => {
    const { clock, advance } = createClock()
    clock.start()
    advance(3_000)
    clock.pause()
    advance(10_000)
    expect(clock.currentTimeMs()).toBe(3_000)
    expect(clock.isRunning).toBe(false)

    clock.resume()
    advance(1_500)
    expect(clock.currentTimeMs()).toBe(4_500)
    expect(clock.snapshot().accumulatedPausedMs).toBe(10_000)
  })

  it('accumulates several pauses', () => {
    const { clock, advance } = createClock()
    clock.start()
    for (let i = 0; i < 3; i++) {
      advance(1_000)
      clock.pause()
      advance(5_000)
      clock.resume()
    }
    expect(clock.currentTimeMs()).toBe(3_000)
    expect(clock.snapshot().accumulatedPausedMs).toBe(15_000)
  })

  it('stays frozen after stop', () => {
    const { clock, advance } = createClock()
    clock.start()
    advance(2_000)
    clock.stop()
    advance(60_000)
    expect(clock.currentTimeMs()).toBe(2_000)
  })

  it('ends at the pause instant when stopped while paused', () => {
    const { clock, advance } = createClock()
    clock.start()
    advance(2_000)
    clock.pause()
    advance(7_000)
    clock.stop()
    expect(clock.currentTimeMs()).toBe(2_000)
  })

  it('re-anchors to the time reported by the capture engine', () => {
    const { clock, advance } = createClock()
    clock.start()
    advance(1_000)
    // The engine says only 940 ms of media exist at this instant.
    clock.alignTo(940)
    expect(clock.currentTimeMs()).toBe(940)
    advance(500)
    expect(clock.currentTimeMs()).toBe(1_440)
  })

  it('rejects invalid transitions', () => {
    const { clock } = createClock()
    expect(() => clock.pause()).toThrow()
    expect(() => clock.resume()).toThrow()
    expect(() => clock.stop()).toThrow()
    expect(() => clock.alignTo(0)).toThrow()
    clock.start()
    expect(() => clock.start()).toThrow()
    expect(() => clock.resume()).toThrow()
  })
})
