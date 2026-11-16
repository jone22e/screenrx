import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logging/logger'
import { SessionStore } from './SessionStore'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

let root: string
let sessions: SessionStore

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'screenrx-sessions-'))
  sessions = new SessionStore(root, silentLogger)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function createCompleted(): Promise<string> {
  const { manifest } = await sessions.create(
    { source: { kind: 'display', label: 'Tela', displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo: true },
    new Date(2026, 10, 16, 14, 0, 0)
  )
  await sessions.write({ ...manifest, status: 'completed' })
  return manifest.id
}

describe('SessionStore series and cover', () => {
  it('puts a recording in a series and takes it out again', async () => {
    const id = await createCompleted()
    expect(await sessions.setSeries(id, 'Tutoriais do Flex')).toBe(true)
    expect((await sessions.list())[0]?.series).toBe('Tutoriais do Flex')
    expect(await sessions.setSeries(id, null)).toBe(true)
    expect((await sessions.list())[0]?.series).toBeNull()
    expect(await sessions.setSeries('recording-20260101-000000-000', 'x')).toBe(false)
  })

  it('renames a series on every recording in it, and removing one leaves its recordings in no series', async () => {
    const a = await createCompleted()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const b = await createCompleted()
    await sessions.setSeries(a, 'Curso')
    await sessions.setSeries(b, 'Curso')
    await sessions.addSeries('Vazia')
    await sessions.renameSeries('Curso', 'Curso completo')
    expect((await sessions.list()).map((entry) => entry.series).sort()).toEqual(['Curso completo', 'Curso completo'])
    expect(await sessions.listSeries()).toEqual(['Curso completo', 'Vazia'])
    await sessions.removeSeries('Curso completo')
    expect((await sessions.list()).map((entry) => entry.series)).toEqual([null, null])
    expect(await sessions.listSeries()).toEqual(['Vazia'])
  })

  it('keeps a cover of its own in the session folder, replacing the one before, and serves it as the thumbnail', async () => {
    const id = await createCompleted()
    expect((await sessions.list())[0]?.hasCover).toBe(false)
    expect(await sessions.setCover(id, { bytes: new Uint8Array([1, 2, 3]), extension: 'png' })).toBe(true)
    const first = await sessions.coverPathOf(id)
    expect(first).toMatch(/cover-\d+\.png$/)
    expect(await readFile(first as string)).toEqual(Buffer.from([1, 2, 3]))
    const summary = (await sessions.list())[0]
    expect(summary?.hasCover).toBe(true)
    expect(summary?.thumbnailUrl).toContain('/thumbnail?cover=cover-')

    await new Promise((resolve) => setTimeout(resolve, 2))
    await sessions.setCover(id, { bytes: new Uint8Array([4]), extension: 'jpg' })
    const second = await sessions.coverPathOf(id)
    expect(second).not.toBe(first)
    const files = (await readdir(path.join(root, id))).filter((file) => file.startsWith('cover-'))
    expect(files).toEqual([path.basename(second as string)])

    await sessions.setCover(id, null)
    expect(await sessions.coverPathOf(id)).toBeNull()
    expect((await readdir(path.join(root, id))).some((file) => file.startsWith('cover-'))).toBe(false)
    expect((await sessions.list())[0]?.thumbnailUrl ?? '').not.toContain('cover=')
  })

  it('drops a cover name that could leave the session folder', async () => {
    const id = await createCompleted()
    const manifest = await sessions.read(id)
    await sessions.write({ ...manifest!, cover: '../../etc/passwd', series: '   ' })
    const again = await sessions.read(id)
    expect(again?.cover).toBeUndefined()
    expect(again?.series).toBeUndefined()
  })
})
