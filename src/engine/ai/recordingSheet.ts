import type { AssistantEditState } from '@shared/models/assistant'
import type { AutoEditBrief } from '@shared/models/autoEdit'
import type { TranscriptWord } from '@shared/models/captions'
import type { CursorSample, InteractionEvent } from '@shared/models/telemetry'
import { ASSISTANT_CONFIG, describeEdit, describeTranscript } from '../assistant/assistantPrompt'
import { platformPreset } from '../export/platformPresets'
import { longPauses } from '../assistant/quickFixes'

/** Everything the agents are told about a recording, in one text. */
export interface RecordingFacts {
  durationMs: number
  words: readonly TranscriptWord[]
  locale: string | null
  interactions: readonly InteractionEvent[]
  cursor: readonly CursorSample[]
  edit: AssistantEditState
  hasWebcam: boolean
  hasMicrophone: boolean
  hasSystemAudio: boolean
  musicName: string | null
  imageNames: readonly string[]
  cursorDrawn: boolean
  /** The video on the second track, with what is said in it on the recording's clock; `null` without one. */
  second?: SecondVideoFacts | null
}

export interface SecondVideoFacts {
  name: string
  /** What each video is, as the user said ("a gameplay", "minha reação"). */
  firstRole: string
  secondRole: string
  /** Its speech, moved onto the recording's clock; empty when it has no sound or was not transcribed. */
  words: readonly TranscriptWord[]
  transcribed: boolean
}

export const SHEET_CONFIG = {
  /** The recording is described in windows this long: clicks, pointer travel, speech. */
  windowMs: 10_000,
  /** Clicks per window from which a window counts as busy on screen. */
  busyClicks: 3
} as const

const clock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** What happened on screen and in the narration, window by window. */
export function activityWindows(facts: Pick<RecordingFacts, 'durationMs' | 'words' | 'interactions' | 'cursor' | 'second'>): string {
  const { windowMs } = SHEET_CONFIG
  const count = Math.max(1, Math.ceil(facts.durationMs / windowMs))
  const lines: string[] = []
  const clicks = facts.interactions.filter((event) => event.type === 'click' || event.type === 'doubleClick' || event.type === 'rightClick')
  for (let index = 0; index < count; index++) {
    const startMs = index * windowMs
    const endMs = Math.min(facts.durationMs, startMs + windowMs)
    const windowClicks = clicks.filter((event) => event.timeMs >= startMs && event.timeMs < endMs).length
    const samples = facts.cursor.filter((sample) => sample.timeMs >= startMs && sample.timeMs < endMs)
    let travel = 0
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1] as CursorSample
      const b = samples[i] as CursorSample
      travel += Math.hypot(b.x - a.x, b.y - a.y)
    }
    const spoken = facts.words.filter((word) => word.startMs < endMs && word.endMs > startMs).length
    const screen = windowClicks >= SHEET_CONFIG.busyClicks ? 'busy' : windowClicks > 0 || travel > 0.5 ? 'some action' : 'still'
    const voice = spoken === 0 ? 'silent' : spoken < 8 ? 'few words' : 'talking'
    const second = facts.second ? facts.second.words.filter((word) => word.startMs < endMs && word.endMs > startMs).length : null
    lines.push(
      `${clock(startMs)}–${clock(endMs)}: ${windowClicks} clicks, pointer travel ${travel.toFixed(1)}, ${spoken} words — screen ${screen}, narration ${voice}${second === null ? '' : `; video 2: ${second} words${second === 0 ? ' (silent)' : ''}`}`
    )
  }
  return lines.join('\n')
}

/** The recording as the director and the agents see it. */
export function buildRecordingSheet(facts: RecordingFacts, brief: AutoEditBrief): string {
  const preset = platformPreset(brief.preset)
  const pauses = longPauses(facts.words, facts.edit.cuts)
  const described = facts.words.slice(0, ASSISTANT_CONFIG.maxWords)
  return [
    `Recording: ${clock(facts.durationMs)} long; webcam ${facts.hasWebcam ? 'recorded' : 'none'}; microphone ${facts.hasMicrophone ? 'yes' : 'no'}; system audio ${facts.hasSystemAudio ? 'yes' : 'no'}; music ${facts.musicName ? `"${facts.musicName}" (already brought in)` : 'none'}; images available for layers: ${facts.imageNames.length > 0 ? facts.imageNames.map((name) => `"${name}"`).join(', ') : 'none'}; pointer ${facts.cursorDrawn ? 'drawn by the editor (can be sized)' : 'in the picture or absent'}.`,
    `Goal: ${preset ? `${preset.label} (${preset.hint})` : 'no platform chosen'}; target length ${brief.targetDurationSec ? `${clock(brief.targetDurationSec * 1000)}` : 'whatever it needs'}; tone: ${brief.tone || 'not stated'}.`,
    `Edit state:\n${describeEdit(facts.edit)}`,
    `Activity by window of ${SHEET_CONFIG.windowMs / 1000} s (recording clock):\n${activityWindows(facts)}`,
    pauses.length === 0
      ? 'Long pauses in the narration: none'
      : `Long pauses in the narration (already shortened by a margin), worth cutting:\n${pauses.map((pause) => `  ${clock(pause.startMs)}–${clock(pause.endMs)} (${((pause.endMs - pause.startMs) / 1000).toFixed(1)} s)`).join('\n')}`,
    ...(facts.second ? [describeSecondVideo(facts.second, facts.edit)] : []),
    facts.locale ? `Language of the narration: ${facts.locale}\n\n${describeTranscript(described)}` : describeTranscript(described)
  ].join('\n\n')
}

/** Video 2's speech as timed phrases: a new line at each pause, each with its time on the recording's clock. */
export function describeSecondSpeech(words: readonly TranscriptWord[]): string {
  if (words.length === 0) return '  (nothing said)'
  const lines: string[] = []
  let phrase: TranscriptWord[] = []
  const flush = (): void => {
    const first = phrase[0]
    const last = phrase.at(-1)
    if (first && last) lines.push(`  ${seconds(first.startMs)}–${seconds(last.endMs)} s: ${phrase.map((word) => word.text).join(' ')}`)
    phrase = []
  }
  for (const word of words.slice(0, ASSISTANT_CONFIG.maxWords)) {
    const previous = phrase.at(-1)
    if (previous && (word.startMs - previous.endMs > 700 || phrase.length >= 14)) flush()
    phrase.push(word)
  }
  flush()
  return lines.join('\n')
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1)

/** Who is who in the frame, what video 2 says, and how a two-video edit is done well. */
function describeSecondVideo(second: SecondVideoFacts, edit: AssistantEditState): string {
  const pieces = edit.secondVideo?.pieces ?? []
  const span = pieces.length > 0 ? `${clock(Math.min(...pieces.map((piece) => piece.startMs)))}–${clock(Math.max(...pieces.map((piece) => piece.endMs)))}` : 'unknown'
  return [
    `Two videos in the frame. Video 1 is ${second.firstRole || 'the recording'}: the recording itself, whose transcript is the numbered one below. Video 2 is ${second.secondRole || 'a second video'} ("${second.name}"), on the recording's clock from ${span}, in step with video 1.`,
    second.transcribed
      ? `What is said in video 2 (times in seconds on the recording's clock; refer to it with startSec/endSec):\n${describeSecondSpeech(second.words)}`
      : 'What is said in video 2: unknown (it has no sound, or it was not transcribed).',
    [
      'Two-video editing notes (a professional reaction / commentary edit):',
      '- A cut removes the stretch from both videos at once. Never cut while video 2 is talking or reacting, nor the few seconds of video 1 that video 2 reacts to. Do cut stretches where video 1 has nothing happening or said and video 2 is silent.',
      '- "layout": split screen ("both") is the default while video 2 is on. Give video 2 the whole frame ("video2") for 1–4 s on its strongest reactions (an outburst, a laugh, a punchline: short loud bursts of words after a silence). Give video 1 the whole frame ("video1") for a few seconds when it has something worth seeing large and video 2 is silent. Keep at least 2 s between changes; no flickering. Never more than about one change every 6 s on average.',
      '- Sound: both are usually heard ("both"); video 2 is the commentator, so it must be understood over video 1.',
      '- Titles and call-outs may quote what video 2 says.'
    ].join('\n')
  ].join('\n\n')
}
