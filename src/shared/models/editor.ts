import type { Transcript } from './captions'
import type { DubTrack } from './dub'
import type { FilterTrack } from './filters'
import type { Project } from './project'
import type { CursorSample, InteractionEvent, ObjectTrack } from './telemetry'

/** An image of the session as the editor sees it. */
export interface EditorImage {
  file: string
  name: string
  url: string
  /** 0 when unknown until drawn. */
  widthPx: number
  heightPx: number
}

/** A b-roll clip of the session as the editor sees it. */
export interface EditorClip {
  file: string
  name: string
  url: string
  durationMs: number
  widthPx: number
  heightPx: number
  /** Whether its sound can be heard in a split screen. */
  hasAudio: boolean
}

/** The session's music file, as the editor and the preview see it. */
export interface MusicTrack {
  url: string
  durationMs: number
  /** The name of the file it came from. */
  name: string
}

/** Everything the editor needs to open one recording. */
export interface EditorSession {
  sessionId: string
  title: string
  createdAt: string
  /** Length of the recording (source time). */
  durationMs: number
  /** Whether the system cursor was burned into the screen track (older recordings, imported videos): then none is drawn. */
  cursorInVideo: boolean
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
  /** Where the pointer was, sample by sample; empty when the session has no telemetry. */
  cursor: CursorSample[]
  /** Where an object the user marked goes through the video, when one was tracked. */
  track: ObjectTrack | null
  /** Dubbing tracks already generated for this session, one per language. */
  dubs: DubTrack[]
  /** The music track brought into the session, when there is one. */
  music: MusicTrack | null
  /** Images brought into the session, for the layers; each with the address it is served at. */
  images: EditorImage[]
  /** Clips of video brought into the session as b-roll. */
  clips: EditorClip[]
  /** The screen track with rendered effects, when one has been made, and what it was made from. */
  filterTrack: FilterTrack | null
  /** Speech-to-text of the session's audio, when it has been transcribed. */
  transcript: Transcript | null
  project: Project
}
