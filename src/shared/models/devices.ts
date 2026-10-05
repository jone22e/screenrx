/** A microphone or camera the capture engine can record. */
export interface CaptureDevice {
  id: string
  name: string
  isDefault: boolean
}

export interface CaptureDevices {
  microphones: CaptureDevice[]
  cameras: CaptureDevice[]
}

/**
 * What to record besides the screen. A device id of `null` means the track
 * is off. Each enabled track is written to its own file.
 */
export interface RecordingOptions {
  microphoneId: string | null
  /** Shown in the HUD; kept alongside the id so no lookup is needed to render it. */
  microphoneName: string | null
  systemAudio: boolean
  cameraId: string | null
  cameraName: string | null
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  microphoneId: null,
  microphoneName: null,
  // What the computer plays is part of what is on screen: recorded unless turned off.
  systemAudio: true,
  cameraId: null,
  cameraName: null
}

const MAX_DEVICE_ID_LENGTH = 256

/** Device ids come from the operating system; this only bounds what the renderer may send. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DEVICE_ID_LENGTH
}
