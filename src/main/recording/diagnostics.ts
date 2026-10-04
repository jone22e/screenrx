import { RECORDING_CONFIG } from '@shared/config/recording'
import type { RecordingOptions } from '@shared/models/devices'
import type { SessionDiagnostic } from '@shared/models/session'
import type { CaptureResult } from '../capture/CaptureEngine'

/** A finished track is usable only if it actually holds media. */
export function isUsableRecording(result: CaptureResult, sizeOnDiskBytes: number): boolean {
  return sizeOnDiskBytes > 0 && result.framesWritten > 0 && result.mediaDurationMs > 0
}

/**
 * Compares what the recording clock says with what ended up in each track.
 * Every track of a session should last as long as the clock ran; a
 * discrepancy means the tracks are out of sync, and it is reported — never
 * silently corrected.
 */
export function diagnoseCapture(result: CaptureResult): SessionDiagnostic[] {
  const diagnostics: SessionDiagnostic[] = []

  const tracks: Array<[label: string, durationMs: number | undefined]> = [
    ['Screen', result.mediaDurationMs],
    ['Microphone', result.microphone?.durationMs],
    ['System audio', result.systemAudio?.durationMs],
    ['Webcam', result.webcam?.durationMs]
  ]
  for (const [label, durationMs] of tracks) {
    if (durationMs === undefined) continue
    const driftMs = durationMs - result.durationMs
    if (Math.abs(driftMs) <= RECORDING_CONFIG.maxDurationDriftMs) continue
    diagnostics.push({
      level: 'warning',
      code: 'duration-drift',
      message: `${label} track is ${Math.round(Math.abs(driftMs))} ms ${
        driftMs > 0 ? 'longer' : 'shorter'
      } than the recording clock (${Math.round(result.durationMs)} ms).`
    })
  }

  if (result.framesDropped > 0) {
    diagnostics.push({
      level: 'info',
      code: 'frames-dropped',
      message: `${result.framesDropped} of ${
        result.framesWritten + result.framesDropped
      } frames were dropped because the encoder could not keep up.`
    })
  }

  return diagnostics
}

/** A track the user asked for that produced no file is worth a warning. */
export function diagnoseMissingTracks(
  result: CaptureResult,
  requested: RecordingOptions
): SessionDiagnostic[] {
  const missing: string[] = []
  if (requested.microphoneId && !result.microphone) missing.push('Microphone')
  if (requested.systemAudio && !result.systemAudio) missing.push('System audio')
  if (requested.cameraId && !result.webcam) missing.push('Webcam')
  return missing.map((label) => ({
    level: 'warning',
    code: 'track-missing',
    message: `${label} was enabled but its track was not recorded.`
  }))
}
