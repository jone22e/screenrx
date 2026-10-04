import { useSyncExternalStore } from 'react'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import { IDLE_RECORDING_STATE } from '@shared/models/recording'

/**
 * Mirror of the main process's recording state. The main process is the
 * source of truth; this store only caches its latest snapshot per window.
 */
let snapshot: RecordingStateSnapshot = IDLE_RECORDING_STATE
let receivedAt = performance.now()
let connected = false
const listeners = new Set<() => void>()

function apply(next: RecordingStateSnapshot): void {
  snapshot = next
  receivedAt = performance.now()
  for (const listener of listeners) listener()
}

function connect(): void {
  if (connected) return
  connected = true
  window.screenrx.recording.onStateChanged(apply)
  void window.screenrx.recording.getState().then(apply)
}

function subscribe(listener: () => void): () => void {
  connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRecordingState(): RecordingStateSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Recording time right now, extrapolated from the last snapshot while the clock runs. */
export function currentElapsedMs(): number {
  return snapshot.elapsedMs + (snapshot.clockRunning ? performance.now() - receivedAt : 0)
}
