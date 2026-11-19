import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logging/logger'
import { SessionStore, copyTitle } from './SessionStore'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('SessionStore.duplicate', () => {
  let directory: string
  let sessions: SessionStore

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-duplicate-'))
    sessions = new SessionStore(directory, silentLogger)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('clones the recording with its edit, leaving the original’s Instagram post behind', async () => {
    const created = await sessions.create(
      { source: { kind: 'file', label: 'Deu ruim', displayId: null, windowId: null, appName: null }, fps: 30, cursorInVideo: true },
      new Date(2026, 10, 19, 14, 36, 0, 0)
    )
    await writeFile(created.screenPath, 'video')
    await mkdir(path.join(created.directory, 'assets'))
    await writeFile(path.join(created.directory, 'assets', 'clip.mp4'), 'clip')
    await mkdir(path.join(created.directory, 'publish'))
    await writeFile(path.join(created.directory, 'publish', 'reels.mp4'), 'reel')
    await writeFile(path.join(created.directory, 'project.json'), JSON.stringify({ sessionId: created.manifest.id, layers: [{ id: 'l1' }] }))
    await sessions.write({
      ...created.manifest,
      status: 'completed',
      series: 'GTA',
      lastExportAt: '2026-11-19T17:00:00Z',
      publish: { state: 'published', caption: 'x', approvedAt: '2026-11-19T17:00:00Z', username: 'jones.gameplays', permalink: 'https://www.instagram.com/reel/a/' }
    })

    const copyId = await sessions.duplicate(created.manifest.id, new Date(2026, 10, 19, 16, 0, 0, 0))
    const copy = await sessions.read(copyId)
    expect(copyId).not.toBe(created.manifest.id)
    expect(copy).toMatchObject({ title: 'Deu ruim (cópia)', series: 'GTA', status: 'completed' })
    expect(copy?.publish).toBeUndefined()
    expect(copy?.lastExportAt).toBeUndefined()
    const copyDir = sessions.directoryOf(copyId)
    expect((await readdir(copyDir)).sort()).toEqual(['assets', 'project.json', 'screen.mp4', 'session.json'])
    expect(await readFile(path.join(copyDir, 'assets', 'clip.mp4'), 'utf8')).toBe('clip')
    expect(JSON.parse(await readFile(path.join(copyDir, 'project.json'), 'utf8'))).toEqual({ sessionId: copyId, layers: [{ id: 'l1' }] })
    // The original is as it was.
    expect((await sessions.read(created.manifest.id))?.publish?.state).toBe('published')
    expect((await sessions.list()).map((entry) => entry.title).sort()).toEqual(['Deu ruim', 'Deu ruim (cópia)'])
  })

  it('numbers copies of copies', () => {
    expect(copyTitle('Aula')).toBe('Aula (cópia)')
    expect(copyTitle('Aula (cópia)')).toBe('Aula (cópia 2)')
    expect(copyTitle('Aula (cópia 2)')).toBe('Aula (cópia 3)')
  })
})
