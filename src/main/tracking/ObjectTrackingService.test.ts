import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { ObjectTrackingError, ObjectTrackingService } from './ObjectTrackingService'

const SESSION_ID = 'recording-20260101-000000-000'
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
let directory: string

async function fakeTracker(lines: string[], after = ''): Promise<string> {
  const file = path.join(directory, 'tracker.sh')
  await writeFile(file, ['#!/bin/sh', 'echo "$@" > "$(dirname "$0")/args"', ...lines.map((line) => `echo '${line}'`), after].join('\n'))
  await chmod(file, 0o755)
  return file
}

function createService(binaryPath: string | null) {
  const progress: number[] = []
  const sessions = {
    read: () => Promise.resolve({ assets: { screen: {} } }),
    trackPathOf: () => path.join(directory, 'screen.mp4'),
    directoryOf: () => directory
  } as unknown as SessionStore
  const service = new ObjectTrackingService({ binaryPath, sessions, logger, onProgress: (p) => progress.push(p.fraction) })
  return { service, progress }
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'screenrx-track-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('ObjectTrackingService', () => {
  it('runs the tracker on the screen track, keeps the samples and stores the track', async () => {
    const binary = await fakeTracker([
      '{"type":"status","state":"tracking"}',
      '{"type":"sample","timeMs":1000,"x":0.5,"y":0.4,"w":0.1,"h":0.1,"confidence":1}',
      '{"type":"progress","fraction":0.5}',
      '{"type":"sample","timeMs":1033,"x":0.52,"y":0.41,"w":0.1,"h":0.1,"confidence":0.9}',
      '{"type":"lost","timeMs":1066}',
      '{"type":"done"}'
    ])
    const { service, progress } = createService(binary)
    const track = await service.track(SESSION_ID, { startMs: 1000, rect: { x: 0.45, y: 0.35, width: 0.1, height: 0.1 }, source: 'screen' })
    expect(track.samples).toEqual([
      { timeMs: 1000, x: 0.5, y: 0.4 },
      { timeMs: 1033, x: 0.52, y: 0.41 }
    ])
    expect(track).toMatchObject({ startMs: 1000, endMs: 1033, rect: { x: 0.45, y: 0.35, width: 0.1, height: 0.1 } })
    expect(progress).toEqual([0.5])
    expect(await readFile(path.join(directory, 'args'), 'utf8')).toContain('--rect 0.45,0.35,0.1,0.1')
    const stored = JSON.parse(await readFile(path.join(directory, 'track.json'), 'utf8')) as { samples: unknown[] }
    expect(stored.samples).toHaveLength(2)
  })

  it('reports what the tracker reports, and an object never seen', async () => {
    const failing = await fakeTracker(['{"type":"error","code":"unreadable-video","detail":"no video"}'], 'exit 1')
    const { service } = createService(failing)
    await expect(service.track(SESSION_ID, { startMs: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: 'screen' })).rejects.toBeInstanceOf(ObjectTrackingError)
    const empty = await fakeTracker(['{"type":"done"}'])
    const { service: other } = createService(empty)
    await expect(other.track(SESSION_ID, { startMs: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: 'screen' })).rejects.toThrow(/not seen/)
  })

  it('has no tracker on other platforms', async () => {
    const { service } = createService(null)
    await expect(service.track(SESSION_ID, { startMs: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: 'screen' })).rejects.toThrow(/no tracker/)
  })
})
