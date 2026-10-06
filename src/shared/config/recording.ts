/** Tunables of the recording flow, kept in one place. */
export const RECORDING_CONFIG = {
  /** Frame rate requested from the capture engine. */
  fps: 60,
  /**
   * The system cursor is burned into the screen track for now. Once cursor
   * telemetry and the editor's cursor renderer exist (phase 3+), this is
   * turned off and the cursor is reconstructed from telemetry instead.
   */
  showCursor: true,
  /** Pointer position samples per second, independent of the video frame rate. */
  cursorSampleRateHz: 30,
  /** Frame rate requested from the webcam. */
  webcamFps: 30,
  /**
   * Largest accepted difference between the recording clock and the duration
   * read back from a finished track before it is flagged in the diagnostics.
   */
  maxDurationDriftMs: 150
} as const

/** Fixed file names inside a session directory. */
export const SESSION_FILES = {
  manifest: 'session.json',
  screen: 'screen.mp4',
  microphone: 'microphone.m4a',
  systemAudio: 'system.m4a',
  webcam: 'webcam.mp4',
  cursor: 'cursor.json',
  interactions: 'interactions.json',
  project: 'project.json',
  /** Derived from an audio track; can be regenerated at any time. */
  transcript: 'transcript.json',
  /** Dubbing tracks: speech synthesized in another language. Derived, one per language. */
  dubEn: 'dub-en.m4a',
  dubEs: 'dub-es.m4a',
  dubZh: 'dub-zh.m4a',
  dubPt: 'dub-pt.m4a'
} as const
