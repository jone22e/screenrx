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
export function activityWindows(facts: Pick<RecordingFacts, 'durationMs' | 'words' | 'interactions' | 'cursor'>): string {
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
    lines.push(`${clock(startMs)}–${clock(endMs)}: ${windowClicks} clicks, pointer travel ${travel.toFixed(1)}, ${spoken} words — screen ${screen}, narration ${voice}`)
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
    facts.locale ? `Language of the narration: ${facts.locale}\n\n${describeTranscript(described)}` : describeTranscript(described)
  ].join('\n\n')
}
