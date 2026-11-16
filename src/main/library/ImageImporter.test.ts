import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { ImageImportError, ImageImporter } from './ImageImporter'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('ImageImporter', () => {
  const binaries = bundledFfmpegBinaries()
  const ffmpeg = new FfmpegService(binaries, silentLogger)
  let directory: string
  let sessions: SessionStore
  let importer: ImageImporter
  let sessionId: string

  const makePng = (name: string, size: string): string => {
    const file = path.join(directory, name)
    const result = spawnSync(binaries.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:size=${size}`, '-frames:v', '1', file], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return file
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-images-'))
    sessions = new SessionStore(path.join(directory, 'sessions'), silentLogger)
    importer = new ImageImporter({ ffmpeg, sessions, logger: silentLogger })
    const created = await sessions.create(
      { source: { kind: 'display', label: 'Display 1', displayId: 1, windowId: null, appName: null }, fps: 30, cursorInVideo: true },
      new Date(2026, 10, 16, 10, 0, 0, 0)
    )
    sessionId = created.manifest.id
    await sessions.write({ ...created.manifest, status: 'completed' })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('copies a PNG into the assets folder with its size, and lists it in the manifest', async () => {
    const image = await importer.import(sessionId, makePng('logo.png', '64x32'))
    expect(image.name).toBe('logo.png')
    expect(image.file).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect([image.widthPx, image.heightPx]).toEqual([64, 32])
    await access(path.join(importer.assetsDirectory(sessionId), image.file))
    expect((await sessions.read(sessionId))?.assets.images).toEqual([image])
  })

  it('takes an SVG without knowing its size, and refuses what is not an image', async () => {
    const svg = path.join(directory, 'mark.svg')
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    const image = await importer.import(sessionId, svg)
    expect([image.widthPx, image.heightPx]).toEqual([0, 0])
    const text = path.join(directory, 'notes.txt')
    await writeFile(text, 'nada')
    await expect(importer.import(sessionId, text)).rejects.toBeInstanceOf(ImageImportError)
    await expect(importer.import(sessionId, text)).rejects.toMatchObject({ appError: { code: 'image-unsupported' } })
  })

  it('removes one image and keeps the others, and refuses a name that is a path', async () => {
    const first = await importer.import(sessionId, makePng('a.png', '8x8'))
    const second = await importer.import(sessionId, makePng('b.png', '8x8'))
    await importer.remove(sessionId, first.file)
    expect((await sessions.read(sessionId))?.assets.images?.map((image) => image.file)).toEqual([second.file])
    await expect(access(path.join(importer.assetsDirectory(sessionId), first.file))).rejects.toThrow()
    await expect(importer.remove(sessionId, '../session.json')).rejects.toBeInstanceOf(ImageImportError)
  })
})
