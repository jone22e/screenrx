import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic, writeJsonAtomic } from './atomicWrite'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'screenrx-atomic-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('creates the file and leaves no temporary files behind', async () => {
    const target = path.join(directory, 'session.json')
    await writeJsonAtomic(target, { id: 'a' })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ id: 'a' })
    expect(await readdir(directory)).toEqual(['session.json'])
  })

  it('replaces existing content', async () => {
    const target = path.join(directory, 'session.json')
    await writeFile(target, 'old')
    await writeFileAtomic(target, 'new')
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('cleans up the temporary file when the final rename fails', async () => {
    // A directory sitting where the file should go makes the rename fail.
    const target = path.join(directory, 'occupied')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['occupied'])
  })

  it('fails when the directory does not exist', async () => {
    const target = path.join(directory, 'missing', 'session.json')
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })
})
