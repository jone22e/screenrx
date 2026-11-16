import { describe, expect, it, vi } from 'vitest'
import type { AssistantAction } from '@shared/models/assistant'
import { createProject } from '@shared/models/project'
import type { EditorSession } from '@shared/models/editor'
import { EditorStore } from './EditorStore'

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
    music: null,
    images: [],
    clips: [],
    cursorInVideo: true,
    filterTrack: null,
    transcript: null,
    project: createProject(SESSION_ID),
    ...overrides
  }
}

const store = (overrides: Partial<EditorSession> = {}): EditorStore =>
  new EditorStore(session(overrides), async () => ({ ok: true, value: null }))

const cutterActions: AssistantAction[] = [
  { type: 'cut', startMs: 1000, endMs: 3000 },
  { type: 'cut', startMs: 10_000, endMs: 12_000 }
]
const cameraActions: AssistantAction[] = [{ type: 'zoom', startMs: 20_000, endMs: 24_000, scale: 2 }]

/** The team as the panel runs it: agents landing in the open, at the same time, with no pause between actions. */
async function runTeam(editor: EditorStore, onAction = vi.fn()): Promise<void> {
  editor.beginTeam()
  await Promise.all([
    editor.applyWorkerLive('cutter', cutterActions, vi.fn(), 0, onAction),
    editor.applyWorkerLive('camera', cameraActions, vi.fn(), 0, onAction)
  ])
  editor.endTeam()
}

describe('the team editing in the open', () => {
  it('applies every action one at a time, telling of each, and closes the team as one undo step', async () => {
    const editor = store()
    const onAction = vi.fn()
    await runTeam(editor, onAction)

    const state = editor.getState()
    expect(state.trims.map(({ startMs }) => startMs)).toEqual([1000, 10_000])
    expect(state.zooms).toHaveLength(1)
    // Each action was reported with its index inside its agent's list.
    expect(onAction.mock.calls.map(([action, index]) => [(action as AssistantAction).type, index])).toEqual(
      expect.arrayContaining([
        ['cut', 0],
        ['cut', 1],
        ['zoom', 0]
      ])
    )

    editor.undo()
    expect(editor.getState().trims).toEqual([])
    expect(editor.getState().zooms).toEqual([])
    expect(editor.getState().canUndo).toBe(false)
  })

  it('takes back one agent on its own, keeping the others, as long as nothing else changed', async () => {
    const editor = store()
    await runTeam(editor)
    expect(editor.canUndoWorker('cutter')).toBe(true)
    expect(editor.canUndoWorker('sound')).toBe(false)

    expect(editor.undoWorker('cutter', vi.fn())).toBe(true)
    expect(editor.getState().trims).toEqual([])
    expect(editor.getState().zooms).toHaveLength(1)
    expect(editor.canUndoWorker('cutter')).toBe(false)
    expect(editor.canUndoWorker('camera')).toBe(true)

    // That undo is itself one step: ⌘Z brings the cutter's work back.
    editor.undo()
    expect(editor.getState().trims).toHaveLength(2)

    // After any other edit the per-agent undo is gone; ⌘Z remains.
    editor.setBackground({ presetId: 'ocean' })
    expect(editor.canUndoWorker('camera')).toBe(false)
    expect(editor.undoWorker('camera', vi.fn())).toBe(false)
  })

  it('puts an agent redone in place of its old work', async () => {
    const editor = store()
    await runTeam(editor)
    expect(editor.replaceWorker('camera', [{ type: 'zoom', startMs: 30_000, endMs: 32_000, scale: 1.5 }], vi.fn())).toBe(true)
    const state = editor.getState()
    expect(state.zooms).toHaveLength(1)
    expect(state.zooms[0]).toMatchObject({ startMs: 30_000, endMs: 32_000 })
    expect(state.trims).toHaveLength(2)
    expect(editor.canUndoWorker('camera')).toBe(true)
  })

  it('stops landing an agent whose team was taken down', async () => {
    const editor = store()
    editor.beginTeam()
    const landing = editor.applyWorkerLive('cutter', cutterActions, vi.fn(), 20, vi.fn())
    await new Promise((resolve) => setTimeout(resolve, 5))
    editor.endTeam()
    editor.undo()
    await landing
    // The first cut had landed and was undone with the team; the second never landed.
    expect(editor.getState().trims).toEqual([])
    expect(editor.getState().canUndo).toBe(false)
  })
})
