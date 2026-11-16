import { describe, expect, it } from 'vitest'
import type { AssistantEditState } from '@shared/models/assistant'
import type { AutoEditBrief, WorkerResult } from '@shared/models/autoEdit'
import type { TranscriptWord } from '@shared/models/captions'
import { assembleWorkers } from './assembly'
import { buildDirectorPrompt, parseDirectorResponse } from './directorPrompt'
import { activityWindows, buildRecordingSheet } from './recordingSheet'
import { WORKER_SPECS, buildWorkerPrompt, parseWorkerResponse } from './workerPrompts'

const words: TranscriptWord[] = [
  { text: 'oi', startMs: 1000, endMs: 1300 },
  { text: 'hoje', startMs: 1400, endMs: 1700 },
  { text: 'vamos', startMs: 1800, endMs: 2100 },
  { text: 'instalar', startMs: 6000, endMs: 6500 },
  { text: 'tchau', startMs: 12_000, endMs: 12_400 }
]
const edit: AssistantEditState = {
  durationMs: 20_000,
  cuts: [],
  zooms: [],
  speed: 1,
  speedRegions: [],
  hasCaptions: true,
  captionsVisible: true,
  captionLanguage: null,
  captionLength: 'medium',
  captionMode: 'block',
  backgroundId: 'aurora',
  exportPreset: 'custom',
  hasWebcam: false,
  webcamVisible: true,
  hasSystemAudio: true,
  microphoneMuted: false,
  systemAudioMuted: false,
  microphoneVolume: 1,
  systemAudioVolume: 1,
  music: null
}
const brief: AutoEditBrief = { preset: 'reels', targetDurationSec: 60, tone: 'tutorial direto', roles: ['cutter', 'camera', 'captioner'] }
const facts = {
  durationMs: 20_000,
  words,
  locale: 'pt-BR',
  interactions: [
    { timeMs: 500, type: 'click' as const, x: 0.1, y: 0.1, button: 'left' as const },
    { timeMs: 900, type: 'click' as const, x: 0.2, y: 0.1, button: 'left' as const },
    { timeMs: 1200, type: 'click' as const, x: 0.3, y: 0.1, button: 'left' as const },
    { timeMs: 15_000, type: 'mouseDown' as const, x: 0.3, y: 0.1, button: 'left' as const }
  ],
  cursor: [{ timeMs: 0, x: 0, y: 0 }, { timeMs: 5000, x: 1, y: 1 }, { timeMs: 11_000, x: 1, y: 1 }],
  edit,
  hasWebcam: false,
  hasMicrophone: true,
  hasSystemAudio: true,
  musicName: 'beat.mp3',
  imageNames: ['logo.png'],
  cursorDrawn: true
}

describe('recording sheet', () => {
  it('describes the activity window by window', () => {
    const lines = activityWindows(facts).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('0:00–0:10: 3 clicks')
    expect(lines[0]).toContain('screen busy, narration few words')
    expect(lines[1]).toContain('0:10–0:20: 0 clicks')
    expect(lines[1]).toContain('narration few words')
  })

  it('puts the goal, the facts, the pauses and the transcript on the sheet', () => {
    const sheet = buildRecordingSheet(facts, brief)
    expect(sheet).toContain('music "beat.mp3"')
    expect(sheet).toContain('images available for layers: "logo.png"')
    expect(sheet).toContain('Goal: Reels')
    expect(sheet).toContain('target length 1:00')
    expect(sheet).toContain('Long pauses in the narration (already shortened by a margin), worth cutting:')
    expect(sheet).toContain('0 oi')
    expect(sheet).toContain('Language of the narration: pt-BR')
  })
})

describe('director', () => {
  it('asks for a plan only for the agents the user wants', () => {
    const { prompt, system } = buildDirectorPrompt('SHEET', brief)
    expect(system).toContain('"cutter"')
    expect(prompt).toContain('Agents asked for by the user: cutter, camera, captioner')
  })

  it('turns the answer into chapters on the clock and briefs for the agents asked for', () => {
    const plan = parseDirectorResponse(
      {
        summary: 'Tutorial curto.',
        chapters: [{ fromWord: 3, toWord: 4, title: 'Instalação' }, { fromWord: 0, toWord: 2, title: 'Abertura' }, { fromWord: 9, toWord: 1, title: 'ruim' }],
        preset: 'tiktok',
        targetDurationSec: 45,
        captionMode: 'highlight',
        workers: [{ role: 'cutter', brief: 'corta o começo' }, { role: 'sound', brief: 'não pedido' }, { role: 'cutter', brief: 'repetido' }]
      },
      words,
      20_000,
      brief
    )
    expect(plan.chapters).toEqual([
      { startMs: 1000, endMs: 2100, title: 'Abertura' },
      { startMs: 6000, endMs: 12_400, title: 'Instalação' }
    ])
    expect(plan.preset).toBe('tiktok')
    expect(plan.captionMode).toBe('highlight')
    // The sound agent was not asked for; camera and captioner were and still run, on the general plan.
    expect(plan.workers).toEqual([
      { role: 'cutter', brief: 'corta o começo' },
      { role: 'camera', brief: '' },
      { role: 'captioner', brief: '' }
    ])
  })
})

describe('agents', () => {
  const plan = parseDirectorResponse({ summary: 's', chapters: [{ fromWord: 0, toWord: 4, title: 'Tudo' }], preset: 'reels', targetDurationSec: null, captionMode: 'highlight', workers: [{ role: 'cutter', brief: 'corta' }] }, words, 20_000, brief)

  it('tells each agent its lanes, the plan and its brief', () => {
    const { system, prompt } = buildWorkerPrompt('cutter', 'SHEET', plan, 'não corte o fim')
    expect(system).toContain('"cut", "uncut", "speed-region", "speed"')
    expect(prompt).toContain('Your brief: corta')
    expect(prompt).toContain('Further instruction from the user, which comes first: não corte o fim')
    expect(buildWorkerPrompt('art', 'SHEET', plan).prompt).toContain('use your judgement within the plan')
  })

  it('keeps only the actions of the agent lanes, each with its reason, dropping the broken ones', () => {
    const action = (fields: Record<string, unknown>) => ({ fromWord: null, toWord: null, startSec: null, endSec: null, scale: null, value: null, reason: 'porque sim', ...fields })
    const { actions, notes } = parseWorkerResponse(
      {
        notes: 'Cortei o começo.',
        actions: [
          action({ type: 'cut', fromWord: 0, toWord: 1 }),
          action({ type: 'zoom', startSec: 1, endSec: 4 }),
          action({ type: 'cut', fromWord: 99 }),
          action({ type: 'speed-region', startSec: 5, endSec: 9, value: '2' })
        ]
      },
      'cutter',
      words,
      20_000
    )
    expect(notes).toBe('Cortei o começo.')
    expect(actions).toEqual([
      { action: { type: 'cut', startMs: 1000, endMs: 1800 }, reason: 'porque sim' },
      { action: { type: 'speed-region', startMs: 5000, endMs: 9000, speed: 2 }, reason: 'porque sim' }
    ])
    expect(Object.keys(WORKER_SPECS)).toEqual(['cutter', 'camera', 'captioner', 'sound', 'art'])
  })
})

describe('assembly', () => {
  const result = (role: WorkerResult['role'], actions: WorkerResult['actions']): WorkerResult => ({ role, actions, notes: '', elapsedMs: 0, error: null })

  it('applies the cutter first and drops what falls inside a cut, moving chapter titles to where the edit resumes', () => {
    const results = [
      result('captioner', [
        { action: { type: 'text', text: 'Abertura', startMs: 1000, endMs: 4000 }, reason: '' },
        { action: { type: 'text', text: 'perdido', startMs: 7000, endMs: 8000 }, reason: '' },
        { action: { type: 'caption-mode', mode: 'highlight' }, reason: '' }
      ]),
      result('camera', [
        { action: { type: 'zoom', startMs: 7000, endMs: 9000, scale: null }, reason: '' },
        { action: { type: 'zoom', startMs: 12_000, endMs: 15_000, scale: 2 }, reason: '' }
      ]),
      result('cutter', [{ action: { type: 'cut', startMs: 6000, endMs: 10_000 }, reason: '' }])
    ]
    const assembled = assembleWorkers(results, [{ startMs: 0, endMs: 5000 }], [{ startMs: 1000, endMs: 5000, title: 'Abertura' }])
    expect(assembled.map((entry) => entry.role)).toEqual(['cutter', 'camera', 'captioner'])
    expect(assembled[1]?.actions.map((entry) => entry.action)).toEqual([{ type: 'zoom', startMs: 12_000, endMs: 15_000, scale: 2 }])
    expect(assembled[2]?.actions.map((entry) => entry.action)).toEqual([
      { type: 'text', text: 'Abertura', startMs: 5000, endMs: 8000 },
      { type: 'caption-mode', mode: 'highlight' }
    ])
  })
})
