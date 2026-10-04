import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, ZoomEffect } from '@shared/models/project'
import type { RecordingSessionManifest } from '@shared/models/session'
import type { Logger } from '../logging/logger'
import { SessionStore } from '../recording/SessionStore'
import { ProjectStore, SessionNotEditableError } from './ProjectStore'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const sessionId = 'recording-20261003-201530-123'

let root: string
let projects: ProjectStore

function manifest(overrides: Partial<RecordingSessionManifest> = {}): RecordingSessionManifest {
  return {
    schemaVersion: 1,
    id: sessionId,
    createdAt: '2026-10-03T23:15:30.123Z',
    status: 'completed',
    source: { kind: 'display', label: 'Display 1', displayId: 1, windowId: null, appName: null },
    capture: { fps: 60, cursorInVideo: true },
    clock: { durationMs: 20_000, pauses: [] },
    assets: {
      screen: {
        file: 'screen.mp4',
        sizeBytes: 1024,
        durationMs: 20_000,
        widthPx: 3024,
        heightPx: 1964,
        frameCount: 1200,
        droppedFrameCount: 0
      }
    },
    diagnostics: [],
    ...overrides
  }
}

const write = (file: string, value: unknown): Promise<void> =>
  writeFile(path.join(root, sessionId, file), JSON.stringify(value))

const readProject = async (): Promise<Project> =>
  JSON.parse(await readFile(path.join(root, sessionId, 'project.json'), 'utf8')) as Project

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'screenrx-projects-'))
  await mkdir(path.join(root, sessionId))
  await write('session.json', manifest())
  projects = new ProjectStore(new SessionStore(root, silentLogger), silentLogger)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ProjectStore', () => {
  it('creates the project of a new recording with zooms generated from its clicks', async () => {
    await write('interactions.json', [
      { timeMs: 5000, type: 'mouseDown', x: 0.72, y: 0.4, button: 'left' },
      { timeMs: 5000, type: 'click', x: 0.72, y: 0.4, button: 'left' },
      { timeMs: 6300, type: 'click', x: 0.74, y: 0.42, button: 'left' },
      { timeMs: 15_000, type: 'click', x: 0.2, y: 0.8, button: 'left' }
    ])

    const session = await projects.open(sessionId)
    expect(session).toMatchObject({
      sessionId,
      title: 'Display 1',
      durationMs: 20_000,
      video: { url: `screenrx-media://session/${sessionId}/screen`, widthPx: 3024, heightPx: 1964 }
    })
    expect(session.interactions).toHaveLength(4)

    const zooms = session.project.effects as ZoomEffect[]
    expect(zooms).toHaveLength(2)
    expect(zooms.every((zoom) => zoom.type === 'zoom' && zoom.mode === 'auto')).toBe(true)
    expect(zooms[0]?.focus.x).toBeCloseTo(0.73)
    // The generated project is on disk right away.
    expect(await readProject()).toEqual(session.project)
  })

  it('does not regenerate zooms for a recording that already has a project', async () => {
    await write('interactions.json', [{ timeMs: 5000, type: 'click', x: 0.5, y: 0.5, button: 'left' }])
    const first = await projects.open(sessionId)
    // The user deletes every zoom…
    await projects.save({ ...first.project, effects: [] })
    // …and they stay deleted when the recording is opened again.
    expect((await projects.open(sessionId)).project.effects).toEqual([])
  })

  it('generates the project once when opened twice at the same time', async () => {
    await write('interactions.json', [{ timeMs: 5000, type: 'click', x: 0.5, y: 0.5, button: 'left' }])
    const [first, second] = await Promise.all([projects.open(sessionId), projects.open(sessionId)])
    expect(first.project).toEqual(second.project)
    expect(await readProject()).toEqual(first.project)
  })

  it('opens a recording without telemetry with an empty project', async () => {
    const session = await projects.open(sessionId)
    expect(session.interactions).toEqual([])
    expect(session.project.effects).toEqual([])
  })

  it('never touches the recorded tracks when saving', async () => {
    await write('interactions.json', [{ timeMs: 5000, type: 'click', x: 0.5, y: 0.5, button: 'left' }])
    const before = await readFile(path.join(root, sessionId, 'interactions.json'), 'utf8')
    const session = await projects.open(sessionId)
    await projects.save({ ...session.project, effects: [] })
    expect(await readFile(path.join(root, sessionId, 'interactions.json'), 'utf8')).toBe(before)
    expect(await readFile(path.join(root, sessionId, 'session.json'), 'utf8')).toBe(JSON.stringify(manifest()))
  })

  it('refuses recordings that are not finished', async () => {
    await write('session.json', manifest({ status: 'failed', assets: {} }))
    await expect(projects.open(sessionId)).rejects.toBeInstanceOf(SessionNotEditableError)
  })
})
