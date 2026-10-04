import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAvcConfiguration, readAvcConfiguration } from './mp4'

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

/** AVCDecoderConfigurationRecord: version 1, High profile (0x64), level 5.1 (0x33). */
const avcC = Buffer.from([1, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x02, 0xaa, 0xbb])
const moov = box('moov', box('trak', box('stbl', Buffer.concat([Buffer.alloc(12), box('avcC', avcC)]))))

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'screenrx-mp4-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('findAvcConfiguration', () => {
  it('extracts the payload and derives the codec string', () => {
    const configuration = findAvcConfiguration(moov)
    expect(configuration?.codec).toBe('avc1.640033')
    expect(Buffer.from(configuration?.description ?? [])).toEqual(avcC)
  })

  it('returns null when there is no H.264 track', () => {
    expect(findAvcConfiguration(box('moov', box('trak', Buffer.alloc(40))))).toBeNull()
  })
})

describe('readAvcConfiguration', () => {
  it('finds the moov after the media data, as the recorder writes it', async () => {
    const file = path.join(directory, 'screen.mp4')
    await writeFile(
      file,
      Buffer.concat([box('ftyp', Buffer.alloc(16)), box('mdat', Buffer.alloc(5000, 7)), moov])
    )
    expect((await readAvcConfiguration(file)).codec).toBe('avc1.640033')
  })

  it('fails clearly on a file without one', async () => {
    const file = path.join(directory, 'broken.mp4')
    await writeFile(file, Buffer.concat([box('ftyp', Buffer.alloc(16)), box('mdat', Buffer.alloc(64))]))
    await expect(readAvcConfiguration(file)).rejects.toThrow(/No H.264 configuration/)
  })
})
