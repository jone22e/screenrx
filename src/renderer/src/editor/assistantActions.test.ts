import { describe, expect, it, vi } from 'vitest'
import type { AssistantAction } from '@shared/models/assistant'
import type { EditorSession } from '@shared/models/editor'
import { createProject } from '@shared/models/project'
import { EditorStore } from './EditorStore'
import { applyAssistantActions } from './assistantActions'

const SESSION_ID = 'recording-20260101-000000-000'

function session(overrides: Partial<EditorSession> = {}): EditorSession {
  return {
    sessionId: SESSION_ID,
    title: 'Teste',
    createdAt: '2026-01-01T00:00:00.000Z',
    durationMs: 60_000,
    video: { url: 'screenrx-media://session/x/screen', widthPx: 1920, heightPx: 1080 },
    webcam: null,
    audio: [{ kind: 'microphone', url: 'screenrx-media://session/x/microphone' }],
    interactions: [],
    cursor: [],
    track: null,
    dubs: [],
    transcript: null,
    project: createProject(SESSION_ID),
    ...overrides
  }
}

const store = (overrides: Partial<EditorSession> = {}): EditorStore =>
  new EditorStore(session(overrides), async () => ({ ok: true, value: null }))

describe('applyAssistantActions', () => {
  it('makes every edit of one message as a single undo step', () => {
    const editor = store()
    const before = editor.getState()
    const actions: AssistantAction[] = [
      { type: 'cut', startMs: 1000, endMs: 3000 },
      { type: 'zoom', startMs: 10_000, endMs: 14_000, scale: 2 },
      { type: 'speed', speed: 1.5 },
      { type: 'background', presetId: 'ocean' },
      { type: 'mute', track: 'microphone', muted: true }
    ]
    const applied = applyAssistantActions(editor, actions, vi.fn())

    expect(applied.skipped).toEqual([])
    expect(applied.done).toEqual(['Corte 00:01,0–00:03,0', 'Zoom 00:10,0–00:14,0', 'Velocidade 1,5×', 'Fundo Oceano', 'microfone mudo'])
    const state = editor.getState()
    expect(state.trims.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([{ startMs: 1000, endMs: 3000 }])
    expect(state.zooms).toHaveLength(1)
    expect(state.zooms[0]).toMatchObject({ startMs: 10_000, endMs: 14_000, scale: 2, mode: 'manual' })
    expect(state.exportSettings.speed).toBe(1.5)
    expect(before.background.presetId).not.toBe('ocean')
    expect(state.background.presetId).toBe('ocean')
    expect(state.audio.microphone.muted).toBe(true)

    editor.undo()
    const undone = editor.getState()
    expect(undone.trims).toEqual([])
    expect(undone.zooms).toEqual([])
    expect(undone.exportSettings.speed).toBe(1)
    expect(undone.background.presetId).toBe(before.background.presetId)
    expect(undone.audio.microphone.muted).toBe(false)
    expect(undone.canUndo).toBe(false)
  })

  it('undoes cuts and removes zooms inside a stretch', () => {
    const editor = store()
    applyAssistantActions(
      editor,
      [
        { type: 'cut', startMs: 1000, endMs: 2000 },
        { type: 'cut', startMs: 5000, endMs: 6000 },
        { type: 'zoom', startMs: 20_000, endMs: 23_000, scale: null }
      ],
      vi.fn()
    )
    const applied = applyAssistantActions(
      editor,
      [
        { type: 'uncut', startMs: 4000, endMs: 7000 },
        { type: 'remove-zoom', startMs: 21_000, endMs: 22_000 },
        { type: 'remove-zoom', startMs: 40_000, endMs: 41_000 }
      ],
      vi.fn()
    )
    expect(applied.done).toEqual(['Corte desfeito em 00:04,0–00:07,0', 'Zoom removido em 00:21,0–00:22,0'])
    expect(applied.skipped).toEqual(['Zoom removido em 00:40,0–00:41,0'])
    expect(editor.getState().trims.map((trim) => trim.startMs)).toEqual([1000])
    expect(editor.getState().zooms).toEqual([])
  })

  it('refuses a zoom over another zoom, and reports it', () => {
    const editor = store()
    const applied = applyAssistantActions(
      editor,
      [
        { type: 'zoom', startMs: 10_000, endMs: 14_000, scale: null },
        { type: 'zoom', startMs: 12_000, endMs: 16_000, scale: null }
      ],
      vi.fn()
    )
    expect(applied.done).toEqual(['Zoom 00:10,0–00:14,0'])
    expect(applied.skipped).toEqual(['Zoom 00:12,0–00:16,0'])
  })

  it('skips what the recording does not have, without touching the project', () => {
    const editor = store()
    const applied = applyAssistantActions(
      editor,
      [
        { type: 'captions', visible: false },
        { type: 'caption-length', length: 'short' },
        { type: 'webcam', visible: false },
        { type: 'mute', track: 'systemAudio', muted: true },
        { type: 'caption-language', language: 'en' }
      ],
      vi.fn()
    )
    expect(applied.done).toEqual([])
    expect(applied.skipped).toHaveLength(5)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('writes a text over the video, selected and within the recording', () => {
    const editor = store()
    const applied = applyAssistantActions(editor, [{ type: 'text', text: 'Promoção', startMs: 58_000, endMs: 70_000 }], vi.fn())
    expect(applied.done).toEqual(['Texto “Promoção” 00:58,0–01:10,0'])
    const [text] = editor.getState().texts
    expect(text).toMatchObject({ text: 'Promoção', startMs: 58_000, endMs: 60_000 })
    expect(editor.getState().selectedTextId).toBe(text?.id)
    editor.undo()
    expect(editor.getState().texts).toEqual([])
  })

  it('starts a translation when the language asked for has none yet', () => {
    const editor = store()
    editor.applyTranscript({
      schemaVersion: 1,
      locale: 'pt-BR',
      track: 'microphone',
      words: [
        { text: 'oi', startMs: 1000, endMs: 1300 },
        { text: 'tudo', startMs: 1400, endMs: 1700 },
        { text: 'bem', startMs: 1800, endMs: 2100 }
      ]
    })
    expect(editor.getState().captions.cues.length).toBeGreaterThan(0)
    const translate = vi.fn()
    const applied = applyAssistantActions(editor, [{ type: 'caption-language', language: 'en' }], translate)
    expect(translate).toHaveBeenCalledWith('en')
    expect(applied.done).toEqual(['Traduzindo as legendas para inglês…'])
  })
})
