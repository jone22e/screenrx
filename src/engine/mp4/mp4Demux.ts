/**
 * Reads the sample tables of an MP4 (or MOV) without FFmpeg: which bytes of
 * the file hold each video frame, when it is shown, which ones are
 * keyframes, and what a WebCodecs decoder needs to be configured. This is
 * what the web editor uses in place of `ffprobe` to export; the desktop app
 * keeps probing with FFmpeg.
 *
 * Only what these files need is parsed: one video track in H.264 (`avc1`,
 * `avc3`) or HEVC (`hvc1`, `hev1`), and whether there is an audio track.
 */

/** Random access to the bytes of a file, however it is held (a `File` in the browser, a handle in Node). */
export interface ByteSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** A video track as the exporter reads it: samples in decode order, timestamps as shown. */
export interface DemuxedVideoTrack {
  /** The sample entry type: `avc1`, `hvc1`… */
  kind: string
  /** WebCodecs codec string, e.g. `avc1.640028` or `hvc1.1.6.L120.B0`. */
  codec: string
  /** The `avcC` or `hvcC` payload, the decoder's configuration record. */
  description: Uint8Array
  widthPx: number
  heightPx: number
  /** Presentation time of each sample, in decode order. */
  timestampsUs: number[]
  offsets: number[]
  sizes: number[]
  keyframes: boolean[]
}

export interface DemuxedAudioTrack {
  /** WebCodecs codec string, as far as the sample entry says (`mp4a.40.2` for AAC). */
  codec: string
  sampleRate: number
  channels: number
}

export interface Mp4Description {
  durationMs: number
  video: DemuxedVideoTrack | null
  /** The video sample entry type when it is one this reader does not know (`vp09`, `mp4v`…). */
  unsupportedVideo: string | null
  audio: DemuxedAudioTrack | null
}

export class Mp4Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Mp4Error'
  }
}

/** A `moov` larger than this is not a file this reader should load whole. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024
const HEADER_BYTES = 8

interface Box {
  type: string
  /** Where the payload starts and ends within the buffer. */
  start: number
  end: number
}

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length))

/** The boxes laid end to end in `bytes[start, end)`. */
function boxesIn(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: Box[] = []
  let offset = start
  while (offset + HEADER_BYTES <= end) {
    let size = view.getUint32(offset)
    let header = HEADER_BYTES
    if (size === 1) {
      if (offset + 16 > end) break
      size = Number(view.getBigUint64(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break
    boxes.push({ type: ascii(bytes, offset + 4, 4), start: offset + header, end: offset + size })
    offset += size
  }
  return boxes
}

const childOf = (bytes: Uint8Array, box: Box, type: string): Box | null =>
  boxesIn(bytes, box.start, box.end).find((child) => child.type === type) ?? null

const childrenOf = (bytes: Uint8Array, box: Box, type: string): Box[] =>
  boxesIn(bytes, box.start, box.end).filter((child) => child.type === type)

/** Finds a box by its path from `parent`, e.g. `['mdia', 'minf', 'stbl']`. */
function descend(bytes: Uint8Array, parent: Box, path: readonly string[]): Box | null {
  let current: Box | null = parent
  for (const type of path) {
    current = current ? childOf(bytes, current, type) : null
  }
  return current
}

/** Reads the `moov` box of the file, wherever it is (these recordings keep it at the end). */
async function readMoov(source: ByteSource): Promise<Uint8Array> {
  let offset = 0
  while (offset + HEADER_BYTES <= source.size) {
    const header = await source.read(offset, Math.min(16, source.size - offset))
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    let size = view.getUint32(0)
    let headerSize = HEADER_BYTES
    if (size === 1 && header.byteLength >= 16) {
      size = Number(view.getBigUint64(8))
      headerSize = 16
    } else if (size === 0) {
      size = source.size - offset
    }
    if (size < headerSize) break
    if (ascii(header, 4, 4) === 'moov') {
      if (size > MAX_MOOV_BYTES) throw new Mp4Error('moov box too large')
      const moov = await source.read(offset, size)
      return moov.subarray(headerSize)
    }
    offset += size
  }
  throw new Mp4Error('no moov box: not an MP4 file, or one still being written')
}

interface SampleTables {
  entryType: string
  entry: Box
  dts: number[]
  pts: number[]
  sizes: number[]
  offsets: number[]
  keyframes: boolean[]
}

function readSampleTables(bytes: Uint8Array, stbl: Box): SampleTables | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const stsd = childOf(bytes, stbl, 'stsd')
  const stts = childOf(bytes, stbl, 'stts')
  const stsc = childOf(bytes, stbl, 'stsc')
  const stsz = childOf(bytes, stbl, 'stsz')
  const stco = childOf(bytes, stbl, 'stco') ?? childOf(bytes, stbl, 'co64')
  if (!stsd || !stts || !stsc || !stsz || !stco) return null

  // The first sample description is the one the samples use.
  const entryCount = view.getUint32(stsd.start + 4)
  if (entryCount === 0) return null
  const entrySize = view.getUint32(stsd.start + 8)
  const entry: Box = { type: ascii(bytes, stsd.start + 12, 4), start: stsd.start + 16, end: stsd.start + 8 + entrySize }

  // Sizes.
  const fixedSize = view.getUint32(stsz.start + 4)
  const sampleCount = view.getUint32(stsz.start + 8)
  const sizes = new Array<number>(sampleCount)
  for (let index = 0; index < sampleCount; index++) {
    sizes[index] = fixedSize !== 0 ? fixedSize : view.getUint32(stsz.start + 12 + index * 4)
  }

  // Decode times, from the run lengths of deltas.
  const dts = new Array<number>(sampleCount)
  {
    const count = view.getUint32(stts.start + 4)
    let sample = 0
    let time = 0
    for (let run = 0; run < count && sample < sampleCount; run++) {
      const runCount = view.getUint32(stts.start + 8 + run * 8)
      const delta = view.getUint32(stts.start + 12 + run * 8)
      for (let index = 0; index < runCount && sample < sampleCount; index++) {
        dts[sample++] = time
        time += delta
      }
    }
    while (sample < sampleCount) dts[sample++] = time
  }

  // Presentation times: the decode time plus the composition offset, when frames are reordered.
  const pts = [...dts]
  const ctts = childOf(bytes, stbl, 'ctts')
  if (ctts) {
    const version = bytes[ctts.start] ?? 0
    const count = view.getUint32(ctts.start + 4)
    let sample = 0
    for (let run = 0; run < count && sample < sampleCount; run++) {
      const runCount = view.getUint32(ctts.start + 8 + run * 8)
      const offset = version === 1 ? view.getInt32(ctts.start + 12 + run * 8) : view.getUint32(ctts.start + 12 + run * 8)
      for (let index = 0; index < runCount && sample < sampleCount; index++) {
        pts[sample] = (dts[sample] ?? 0) + offset
        sample++
      }
    }
  }

  // Keyframes: the sync samples, or every sample when the table is absent.
  const keyframes = new Array<boolean>(sampleCount).fill(true)
  const stss = childOf(bytes, stbl, 'stss')
  if (stss) {
    keyframes.fill(false)
    const count = view.getUint32(stss.start + 4)
    for (let index = 0; index < count; index++) {
      const sample = view.getUint32(stss.start + 8 + index * 4) - 1
      if (sample >= 0 && sample < sampleCount) keyframes[sample] = true
    }
  }

  // Offsets: each chunk's position, and how many samples each chunk holds.
  const chunkCount = view.getUint32(stco.start + 4)
  const chunkOffsets = new Array<number>(chunkCount)
  for (let index = 0; index < chunkCount; index++) {
    chunkOffsets[index] =
      stco.type === 'co64' ? Number(view.getBigUint64(stco.start + 8 + index * 8)) : view.getUint32(stco.start + 8 + index * 4)
  }
  const runs: Array<{ firstChunk: number; samplesPerChunk: number }> = []
  {
    const count = view.getUint32(stsc.start + 4)
    for (let index = 0; index < count; index++) {
      runs.push({
        firstChunk: view.getUint32(stsc.start + 8 + index * 12) - 1,
        samplesPerChunk: view.getUint32(stsc.start + 12 + index * 12)
      })
    }
  }
  const offsets = new Array<number>(sampleCount)
  let sample = 0
  for (let chunk = 0; chunk < chunkCount && sample < sampleCount; chunk++) {
    let perChunk = 0
    for (const run of runs) {
      if (run.firstChunk <= chunk) perChunk = run.samplesPerChunk
      else break
    }
    let position = chunkOffsets[chunk] ?? 0
    for (let index = 0; index < perChunk && sample < sampleCount; index++) {
      offsets[sample] = position
      position += sizes[sample] ?? 0
      sample++
    }
  }
  if (sample < sampleCount) return null

  return { entryType: entry.type, entry, dts, pts, sizes, offsets, keyframes }
}

/** `avc1.PPCCLL` from the `avcC` record: profile, constraints, level. */
export function avcCodecString(avcC: Uint8Array): string {
  const hex = (byte: number | undefined): string => (byte ?? 0).toString(16).padStart(2, '0')
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`
}

/**
 * The codec string of an HEVC track from its `hvcC` record, as ISO/IEC
 * 14496-15 spells it: profile space and profile, the compatibility flags
 * (reversed, in hex), tier and level, then the constraint bytes with the
 * trailing zero ones left off. `hvc1.1.6.L120.B0` is Main at level 4.
 */
export function hevcCodecString(kind: string, hvcC: Uint8Array): string {
  const byte = (index: number): number => hvcC[index] ?? 0
  const profileSpace = byte(1) >> 6
  const tier = (byte(1) >> 5) & 1
  const profile = byte(1) & 0x1f
  const compatibility = ((byte(2) << 24) | (byte(3) << 16) | (byte(4) << 8) | byte(5)) >>> 0
  let reversed = 0
  for (let bit = 0; bit < 32; bit++) {
    if ((compatibility >>> (31 - bit)) & 1) reversed |= 1 << bit
  }
  const constraints: number[] = [byte(6), byte(7), byte(8), byte(9), byte(10), byte(11)]
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop()
  const parts = [
    `${['', 'A', 'B', 'C'][profileSpace]}${profile}`,
    (reversed >>> 0).toString(16).toUpperCase(),
    `${tier ? 'H' : 'L'}${byte(12)}`,
    ...constraints.map((value) => value.toString(16).toUpperCase())
  ]
  return `${kind}.${parts.join('.')}`
}

/** The `avcC`/`hvcC` configuration of a video sample entry, or `null` for codecs the reader does not know. */
function videoConfiguration(bytes: Uint8Array, entry: Box): { codec: string; description: Uint8Array } | null {
  // VisualSampleEntry: 78 bytes of fixed fields after the data reference index, then the codec's boxes.
  const children: Box = { type: entry.type, start: entry.start + 78, end: entry.end }
  if (entry.type === 'avc1' || entry.type === 'avc3') {
    const avcC = childOf(bytes, children, 'avcC')
    if (!avcC) return null
    const description = bytes.slice(avcC.start, avcC.end)
    return { codec: avcCodecString(description), description }
  }
  if (entry.type === 'hvc1' || entry.type === 'hev1') {
    const hvcC = childOf(bytes, children, 'hvcC')
    if (!hvcC) return null
    const description = bytes.slice(hvcC.start, hvcC.end)
    return { codec: hevcCodecString(entry.type, description), description }
  }
  return null
}

/** Reads the moov from `source` and describes its tracks. */
export async function describeMp4(source: ByteSource): Promise<Mp4Description> {
  const moov = await readMoov(source)
  const root: Box = { type: 'moov', start: 0, end: moov.byteLength }
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)

  const mvhd = childOf(moov, root, 'mvhd')
  if (!mvhd) throw new Mp4Error('moov without mvhd')
  const mvhdVersion = moov[mvhd.start] ?? 0
  const movieTimescale = mvhdVersion === 1 ? view.getUint32(mvhd.start + 20) : view.getUint32(mvhd.start + 12)
  const movieDuration = mvhdVersion === 1 ? Number(view.getBigUint64(mvhd.start + 24)) : view.getUint32(mvhd.start + 16)
  const durationMs = movieTimescale > 0 ? (movieDuration / movieTimescale) * 1000 : 0

  const description: Mp4Description = { durationMs, video: null, unsupportedVideo: null, audio: null }

  for (const trak of childrenOf(moov, root, 'trak')) {
    const mdhd = descend(moov, trak, ['mdia', 'mdhd'])
    const hdlr = descend(moov, trak, ['mdia', 'hdlr'])
    const stbl = descend(moov, trak, ['mdia', 'minf', 'stbl'])
    if (!mdhd || !hdlr || !stbl) continue
    const handler = ascii(moov, hdlr.start + 8, 4)
    const mdhdVersion = moov[mdhd.start] ?? 0
    const timescale = mdhdVersion === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12)
    if (timescale === 0) continue
    const tables = readSampleTables(moov, stbl)
    if (!tables) continue

    if (handler === 'vide' && description.video === null && description.unsupportedVideo === null) {
      const configuration = videoConfiguration(moov, tables.entry)
      if (!configuration) {
        description.unsupportedVideo = tables.entryType
        continue
      }
      const tkhd = childOf(moov, trak, 'tkhd')
      let widthPx = view.getUint16(tables.entry.start + 24)
      let heightPx = view.getUint16(tables.entry.start + 26)
      if (tkhd && (widthPx === 0 || heightPx === 0)) {
        const base = tkhd.start + ((moov[tkhd.start] ?? 0) === 1 ? 96 : 84)
        widthPx = view.getUint32(base) >>> 16
        heightPx = view.getUint32(base + 4) >>> 16
      }
      // Presentation starts where the edit list says, or at the earliest frame shown.
      const elst = descend(moov, trak, ['edts', 'elst'])
      let shift = Math.min(...tables.pts)
      if (elst && view.getUint32(elst.start + 4) > 0) {
        const elstVersion = moov[elst.start] ?? 0
        const mediaTime = elstVersion === 1 ? Number(view.getBigInt64(elst.start + 16)) : view.getInt32(elst.start + 12)
        if (mediaTime >= 0) shift = mediaTime
      }
      const toUs = (ticks: number): number => Math.round(((ticks - shift) / timescale) * 1_000_000)
      description.video = {
        kind: tables.entryType,
        codec: configuration.codec,
        description: configuration.description,
        widthPx,
        heightPx,
        timestampsUs: tables.pts.map(toUs),
        offsets: tables.offsets,
        sizes: tables.sizes,
        keyframes: tables.keyframes
      }
    } else if (handler === 'soun' && description.audio === null) {
      // AudioSampleEntry: channel count and sample rate sit at fixed places after the data reference index.
      const channels = view.getUint16(tables.entry.start + 16)
      const sampleRate = view.getUint32(tables.entry.start + 24) >>> 16
      description.audio = {
        codec: tables.entryType === 'mp4a' ? 'mp4a.40.2' : tables.entryType,
        sampleRate: sampleRate || timescale,
        channels: channels || 2
      }
    }
  }
  return description
}
