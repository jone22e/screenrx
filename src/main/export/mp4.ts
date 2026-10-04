import { open } from 'node:fs/promises'

/** Decoder configuration of an H.264 track, as stored in an MP4. */
export interface AvcConfiguration {
  /** The `avcC` box payload (AVCDecoderConfigurationRecord). */
  description: Uint8Array
  /** WebCodecs codec string derived from it, e.g. `avc1.640033`. */
  codec: string
}

/** A `moov` larger than this is not something this app wrote. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024
const BOX_HEADER_BYTES = 8

/** Finds the `avcC` payload inside a `moov` box. */
export function findAvcConfiguration(moov: Buffer): AvcConfiguration | null {
  const typeIndex = moov.indexOf('avcC', 0, 'latin1')
  if (typeIndex < 4) return null
  const boxStart = typeIndex - 4
  const boxSize = moov.readUInt32BE(boxStart)
  const payload = moov.subarray(typeIndex + 4, boxStart + boxSize)
  // version, profile, compatibility, level come first.
  if (boxSize < BOX_HEADER_BYTES + 4 || payload.length < 4 || payload[0] !== 1) return null
  const hex = (byte: number | undefined): string => (byte ?? 0).toString(16).padStart(2, '0')
  return {
    description: new Uint8Array(payload),
    codec: `avc1.${hex(payload[1])}${hex(payload[2])}${hex(payload[3])}`
  }
}

/**
 * Reads the H.264 decoder configuration of an MP4 without loading the media:
 * it walks the top-level boxes to the `moov` (which these recordings keep at
 * the end of the file) and reads only that.
 */
export async function readAvcConfiguration(filePath: string): Promise<AvcConfiguration> {
  const file = await open(filePath, 'r')
  try {
    const { size: fileSize } = await file.stat()
    const header = Buffer.alloc(16)
    let offset = 0
    while (offset + BOX_HEADER_BYTES <= fileSize) {
      await file.read(header, 0, 16, offset)
      let boxSize = header.readUInt32BE(0)
      let headerSize = BOX_HEADER_BYTES
      if (boxSize === 1) {
        boxSize = Number(header.readBigUInt64BE(8))
        headerSize = 16
      } else if (boxSize === 0) {
        boxSize = fileSize - offset
      }
      if (boxSize < headerSize) break

      if (header.toString('latin1', 4, 8) === 'moov') {
        if (boxSize > MAX_MOOV_BYTES) break
        const moov = Buffer.alloc(boxSize)
        await file.read(moov, 0, boxSize, offset)
        const configuration = findAvcConfiguration(moov)
        if (configuration) return configuration
        break
      }
      offset += boxSize
    }
  } finally {
    await file.close()
  }
  throw new Error(`No H.264 configuration found in ${filePath}`)
}
