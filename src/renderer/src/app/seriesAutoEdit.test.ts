import { describe, expect, it, vi } from 'vitest'
import type { AiChoice } from '@shared/models/ai'
import type { AutoEditBrief, AutoEditPlan, AutoEditProgress, AutoEditResult, WorkerResult } from '@shared/models/autoEdit'
import type { EditorSession } from '@shared/models/editor'
import { appError } from '@shared/models/errors'
import type { IpcResult } from '@shared/models/errors'
import { createProject } from '@shared/models/project'
import type { Project } from '@shared/models/project'
import type { SeriesAutoEditDeps } from './seriesAutoEdit'
import { SeriesAutoEditRunner } from './seriesAutoEdit'

const EP1 = 'recording-20260101-000000-001'
const EP2 = 'recording-20260101-000000-002'
const EP3 = 'recording-20260101-000000-003'

const brief: AutoEditBrief = { preset: 'reels', targetDurationSec: 60, tone: 'tutorial direto', roles: ['cutter', 'camera'] }
const choice: AiChoice = { provider: 'claude', model: 'default', effort: 'medium' }

function session(sessionId: string): EditorSession {
  return {
    sessionId,
    title: sessionId,
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
    project: createProject(sessionId)
  }
}

const plan: AutoEditPlan = { summary: 'Um corte direto.', chapters: [], preset: 'reels', targetDurationSec: 60, captionMode: 'block', workers: [{ role: 'cutter', brief: '' }, { role: 'camera', brief: '' }] }

const cutter = (): WorkerResult => ({
  role: 'cutter',
  actions: [{ action: { type: 'cut', startMs: 1000, endMs: 3000 }, reason: 'pausa' }],
  notes: '',
  elapsedMs: 10,
  error: null
})
const camera = (): WorkerResult => ({
  role: 'camera',
  actions: [{ action: { type: 'zoom', startMs: 20_000, endMs: 24_000, scale: 2 }, reason: 'clique' }],
  notes: '',
  elapsedMs: 10,
  error: null
})

/** A main process in miniature: it tells of each agent through the events and answers as asked, episode by episode. */
function harness(answer: (sessionId: string, emit: Emitter) => Promise<IpcResult<AutoEditResult>>) {
  const emitter = new Emitter()
  const saved: Project[] = []
  const opened: string[] = []
  const deps: SeriesAutoEditDeps = {
    openSession: async (sessionId) => {
      opened.push(sessionId)
      return { ok: true, value: session(sessionId) }
    },
    autoEdit: (sessionId) => answer(sessionId, emitter),
    saveProject: async (project) => {
      saved.push(project)
      return { ok: true, value: null }
    },
    cancel: vi.fn(),
    translate: async () => ({ ok: true, value: {} }),
    onProgress: (listener) => emitter.on('progress', listener),
    onPlan: (listener) => emitter.on('plan', listener),
    onWorker: (listener) => emitter.on('worker', listener),
    onEpisodeSaved: vi.fn()
  }
  return { runner: new SeriesAutoEditRunner(deps), deps, saved, opened, emitter }
}

class Emitter {
  private readonly listeners = new Map<string, Set<(event: never) => void>>()
  on(name: string, listener: (event: never) => void): () => void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
    return () => set.delete(listener)
  }
  emit(name: 'progress', event: AutoEditProgress): void
  emit(name: 'plan', event: { sessionId: string; plan: AutoEditPlan }): void
  emit(name: 'worker', event: { sessionId: string; result: WorkerResult }): void
  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event as never)
  }
}

/** The whole team answering at once, as the real one does after its agents landed. */
async function fullTeam(sessionId: string, emit: Emitter): Promise<IpcResult<AutoEditResult>> {
  emit.emit('progress', { sessionId, who: 'director', stage: 'done', elapsedMs: 5 })
  emit.emit('plan', { sessionId, plan })
  const workers = [cutter(), camera()]
  for (const result of workers) emit.emit('worker', { sessionId, result })
  await new Promise((resolve) => setTimeout(resolve, 5))
  return { ok: true, value: { plan, workers } }
}

describe('editing every episode of a series', () => {
  it('goes through the episodes in order, one at a time, writing each project once its team is done', async () => {
    const order: string[] = []
    const { runner, saved, opened } = harness(async (sessionId, emit) => {
      // No episode starts before the previous one's answer is back.
      order.push(`start ${sessionId}`)
      const result = await fullTeam(sessionId, emit)
      order.push(`end ${sessionId}`)
      return result
    })
    const states: string[] = []
    runner.subscribe(() => states.push(runner.getState().episodes.map((episode) => episode.status[0]).join('')))

    await runner.start('Curso', [{ id: EP1, title: 'Um' }, { id: EP2, title: 'Dois' }], brief, choice)

    expect(opened).toEqual([EP1, EP2])
    expect(order).toEqual([`start ${EP1}`, `end ${EP1}`, `start ${EP2}`, `end ${EP2}`])
    expect(saved.map((project) => project.sessionId)).toEqual([EP1, EP2])
    // Each project carries the team's work: one cut and one zoom.
    for (const project of saved) {
      expect(project.effects.filter((effect) => effect.type === 'trim')).toHaveLength(1)
      expect(project.effects.filter((effect) => effect.type === 'zoom')).toHaveLength(1)
    }
    const state = runner.getState()
    expect(state.phase).toBe('done')
    expect(state.episodes.map((episode) => [episode.status, episode.actions])).toEqual([
      ['done', 2],
      ['done', 2]
    ])
    expect(state.current).toBeNull()
    // The second only went from queued to editing after the first was done.
    expect(states).toContain('eq')
    expect(states).toContain('de')
    expect(states.indexOf('de')).toBeGreaterThan(states.indexOf('eq'))
  })

  it('shows which agent is at work on the episode under way', async () => {
    const seen: string[] = []
    const { runner } = harness(async (sessionId, emit) => {
      emit.emit('progress', { sessionId, who: 'director', stage: 'thinking', elapsedMs: 0 })
      seen.push(JSON.stringify(runner.getState().current))
      emit.emit('progress', { sessionId, who: 'cutter', stage: 'thinking', elapsedMs: 0 })
      // Events of another recording are not this episode's.
      emit.emit('progress', { sessionId: EP3, who: 'camera', stage: 'thinking', elapsedMs: 0 })
      seen.push(JSON.stringify(runner.getState().current))
      return fullTeam(sessionId, emit)
    })
    await runner.start('Curso', [{ id: EP1, title: 'Um' }], brief, choice)
    expect(seen[0]).toBe(JSON.stringify({ id: EP1, stages: { director: 'thinking' }, summary: null }))
    expect(seen[1]).toBe(JSON.stringify({ id: EP1, stages: { director: 'thinking', cutter: 'thinking' }, summary: null }))
  })

  it('cancelled in the middle: the episode under way is left untouched, the ones done stay, the rest never start', async () => {
    const { runner, deps, saved, opened } = harness(async (sessionId, emit) => {
      if (sessionId === EP1) return fullTeam(sessionId, emit)
      // The second episode's cutter had already landed when the user cancelled.
      emit.emit('worker', { sessionId, result: cutter() })
      await new Promise((resolve) => setTimeout(resolve, 5))
      runner.cancel()
      return { ok: false, error: appError('ai-cancelled') }
    })

    await runner.start('Curso', [{ id: EP1, title: 'Um' }, { id: EP2, title: 'Dois' }, { id: EP3, title: 'Três' }], brief, choice)

    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(opened).toEqual([EP1, EP2])
    expect(saved.map((project) => project.sessionId)).toEqual([EP1])
    const state = runner.getState()
    expect(state.phase).toBe('cancelled')
    expect(state.episodes.map((episode) => episode.status)).toEqual(['done', 'cancelled', 'cancelled'])
    expect(deps.onEpisodeSaved).toHaveBeenCalledWith(EP1)
    expect(deps.onEpisodeSaved).toHaveBeenCalledTimes(1)
  })

  it('an episode that fails is marked and the next one still goes', async () => {
    const { runner, saved } = harness(async (sessionId, emit) => {
      if (sessionId === EP1) return { ok: false, error: appError('ai-failed', 'bad answer') }
      return fullTeam(sessionId, emit)
    })
    await runner.start('Curso', [{ id: EP1, title: 'Um' }, { id: EP2, title: 'Dois' }], brief, choice)
    const state = runner.getState()
    expect(state.phase).toBe('done')
    expect(state.episodes.map((episode) => episode.status)).toEqual(['failed', 'done'])
    expect(state.episodes[0]?.error).toBeTruthy()
    expect(saved.map((project) => project.sessionId)).toEqual([EP2])
  })

  it('refuses a second run while one is on, and knows which recordings it still holds', async () => {
    let release: () => void = () => {}
    const { runner } = harness(async (sessionId, emit) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return fullTeam(sessionId, emit)
    })
    const first = runner.start('Curso', [{ id: EP1, title: 'Um' }, { id: EP2, title: 'Dois' }], brief, choice)
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(runner.working).toBe(true)
    expect(runner.holds(EP1)).toBe(true)
    expect(runner.holds(EP2)).toBe(true)
    expect(runner.holds(EP3)).toBe(false)
    // A second start changes nothing: the run is the first.
    expect(runner.start('Outra', [{ id: EP3, title: 'Três' }], brief, choice)).toBe(first)
    expect(runner.getState().series).toBe('Curso')
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await first
    expect(runner.holds(EP1)).toBe(false)
    expect(runner.getState().phase).toBe('done')
    runner.dismiss()
    expect(runner.getState().phase).toBe('idle')
  })
})
