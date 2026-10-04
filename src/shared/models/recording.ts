import type { RecordingOptions } from './devices'
import { DEFAULT_RECORDING_OPTIONS } from './devices'
import type { AppError } from './errors'

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'

export interface SelectedSource {
  id: string
  kind: 'display' | 'window'
  label: string
}

/**
 * Recording state as broadcast by the main process to every window.
 * It is ephemeral UI state: nothing here is persisted.
 */
export interface RecordingStateSnapshot {
  phase: RecordingPhase
  selectedSource: SelectedSource | null
  /** Microphone, system audio and camera choices for the next recording. */
  options: RecordingOptions
  /** Session being recorded, if any. */
  sessionId: string | null
  /** Recording time (pauses excluded) when this snapshot was taken. */
  elapsedMs: number
  /** Whether recording time is advancing; receivers extrapolate `elapsedMs` locally. */
  clockRunning: boolean
  lastError: AppError | null
  /** Most recent session finished during this app run. */
  lastCompletedSessionId: string | null
}

export const IDLE_RECORDING_STATE: RecordingStateSnapshot = {
  phase: 'idle',
  selectedSource: null,
  options: DEFAULT_RECORDING_OPTIONS,
  sessionId: null,
  elapsedMs: 0,
  clockRunning: false,
  lastError: null,
  lastCompletedSessionId: null
}
