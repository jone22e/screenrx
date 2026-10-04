export type ClockState = 'idle' | 'running' | 'paused' | 'stopped'

export interface RecordingClockSnapshot {
  state: ClockState
  /** Reading of the time source when the recording started. */
  startedAt: number | null
  /** Reading of the time source when the current pause began. */
  pausedAt: number | null
  /** Total time spent paused so far, excluding a pause still in progress. */
  accumulatedPausedMs: number
  /** Recording time: time since start with every paused span removed. */
  currentTimeMs: number
}

/**
 * Logical time of a recording session: elapsed time with paused spans removed.
 *
 * The capture engine owns the authoritative media clock (every track is
 * stamped against it, see RecordingClock.swift). This is its mirror in the
 * main process, used for state and UI; `alignTo` re-anchors it to the times
 * the engine reports at each transition so the two never drift apart.
 *
 * The time source must be monotonic (e.g. `performance.now`), never wall time.
 */
export class RecordingClock {
  private state: ClockState = 'idle'
  private startedAt: number | null = null
  private pausedAt: number | null = null
  private stoppedAt: number | null = null
  private accumulatedPausedMs = 0

  constructor(private readonly now: () => number) {}

  start(): void {
    this.expect('idle', 'start')
    this.startedAt = this.now()
    this.state = 'running'
  }

  pause(): void {
    this.expect('running', 'pause')
    this.pausedAt = this.now()
    this.state = 'paused'
  }

  resume(): void {
    this.expect('paused', 'resume')
    this.accumulatedPausedMs += this.now() - (this.pausedAt ?? this.now())
    this.pausedAt = null
    this.state = 'running'
  }

  stop(): void {
    if (this.state !== 'running' && this.state !== 'paused') {
      throw new Error(`RecordingClock: cannot stop while ${this.state}`)
    }
    // Stopping while paused ends the recording at the instant the pause began.
    this.stoppedAt = this.pausedAt ?? this.now()
    this.pausedAt = null
    this.state = 'stopped'
  }

  /** Makes `currentTimeMs()` equal to the time reported by the capture engine. */
  alignTo(recordingTimeMs: number): void {
    if (this.state === 'idle') {
      throw new Error('RecordingClock: cannot align before start')
    }
    this.accumulatedPausedMs += this.currentTimeMs() - recordingTimeMs
  }

  currentTimeMs(): number {
    if (this.startedAt === null) return 0
    const end = this.stoppedAt ?? this.pausedAt ?? this.now()
    return Math.max(0, end - this.startedAt - this.accumulatedPausedMs)
  }

  get isRunning(): boolean {
    return this.state === 'running'
  }

  snapshot(): RecordingClockSnapshot {
    return {
      state: this.state,
      startedAt: this.startedAt,
      pausedAt: this.pausedAt,
      accumulatedPausedMs: this.accumulatedPausedMs,
      currentTimeMs: this.currentTimeMs()
    }
  }

  private expect(state: ClockState, action: string): void {
    if (this.state !== state) {
      throw new Error(`RecordingClock: cannot ${action} while ${this.state}`)
    }
  }
}
