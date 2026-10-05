import type { Transcript } from './captions'
import type { Project } from './project'
import type { InteractionEvent } from './telemetry'

/** Everything the editor needs to open one recording. */
export interface EditorSession {
  sessionId: string
  title: string
  createdAt: string
  /** Length of the recording (source time). */
  durationMs: number
  video: {
    url: string
    widthPx: number
    heightPx: number
  }
  /** The webcam track, recorded separately from the screen; `null` when there is none. */
  webcam: { url: string; widthPx: number; heightPx: number } | null
  /** Audio tracks of the session, each in its own file. */
  audio: Array<{ kind: 'microphone' | 'systemAudio'; url: string }>
  /** Recorded pointer interactions; empty when the session has no telemetry. */
  interactions: InteractionEvent[]
  /** Speech-to-text of the session's audio, when it has been transcribed. */
  transcript: Transcript | null
  project: Project
}
