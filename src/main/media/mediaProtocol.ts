import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import type { MediaTrack } from '@shared/models/media'
import { MEDIA_SCHEME, isMediaTrack } from '@shared/models/media'
import { isSessionId } from '@shared/models/session'
import path from 'node:path'
import { SESSION_FILES } from '@shared/config/recording'
import { isSafeFileName, resolveInside } from '../filesystem/safePaths'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import type { ThumbnailService } from './ThumbnailService'
import { parseByteRange } from './byteRange'

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif'
}

const CONTENT_TYPES: Record<MediaTrack, string> = {
  dubEn: 'audio/mp4',
  dubEs: 'audio/mp4',
  dubZh: 'audio/mp4',
  dubPt: 'audio/mp4',
  music: 'audio/mp4',
  screen: 'video/mp4',
  screenFx: 'video/mp4',
  webcam: 'video/mp4',
  microphone: 'audio/mp4',
  systemAudio: 'audio/mp4'
}

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // CORS, so a video or image of the scheme drawn on a canvas leaves it exportable (a cover, a saved frame).
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, corsEnabled: true } }
  ])
}

/**
 * Streams recorded media to the renderers as `screenrx-media://session/<id>/<track>`,
 * and each session's poster frame as `…/<id>/thumbnail`.
 * The renderer names a session, never a path, and the file is served in
 * ranges straight from disk — a long recording is never loaded into memory.
 */
/** On every answer: the renderer asks with `crossorigin="anonymous"`, so what it draws stays exportable. */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const

export function serveMedia(sessions: SessionStore, thumbnails: ThumbnailService, logger: Logger): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const [sessionId, resource, assetName] = url.pathname.split('/').filter(Boolean)
    if (url.hostname !== 'session' || !isSessionId(sessionId)) {
      return new Response(null, { status: 404 })
    }

    // A file of the session's assets folder: an image, whole, or a b-roll clip, in ranges like a track.
    let asset: { filePath: string; contentType: string } | null = null
    if (resource === 'asset') {
      const file = assetName === undefined ? '' : decodeURIComponent(assetName)
      if (!isSafeFileName(file)) return new Response(null, { status: 404 })
      const extension = path.extname(file).slice(1).toLowerCase()
      try {
        const filePath = resolveInside(path.join(sessions.directoryOf(sessionId), SESSION_FILES.assets), file)
        if (extension !== 'mp4') {
          return new Response(await readFile(filePath), {
            headers: { ...CORS_HEADERS, 'Content-Type': IMAGE_CONTENT_TYPES[extension] ?? 'application/octet-stream' }
          })
        }
        asset = { filePath, contentType: 'video/mp4' }
      } catch {
        return new Response(null, { status: 404 })
      }
    }

    if (resource === 'thumbnail') {
      try {
        // A cover of the user's choosing stands in for the poster frame.
        const cover = await sessions.coverPathOf(sessionId)
        if (cover) {
          const extension = path.extname(cover).slice(1).toLowerCase()
          return new Response(await readFile(cover), {
            headers: { ...CORS_HEADERS, 'Content-Type': IMAGE_CONTENT_TYPES[extension] ?? 'image/jpeg', 'Cache-Control': 'max-age=3600' }
          })
        }
        return new Response(await readFile(await thumbnails.thumbnailOf(sessionId)), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' }
        })
      } catch (error) {
        logger.warn('no thumbnail', { sessionId, error: String(error) })
        return new Response(null, { status: 404 })
      }
    }
    if (!asset && !isMediaTrack(resource)) return new Response(null, { status: 404 })

    let filePath: string
    let size: number
    try {
      filePath = asset ? asset.filePath : sessions.trackPathOf(sessionId, resource as MediaTrack)
      size = (await stat(filePath)).size
    } catch {
      return new Response(null, { status: 404 })
    }
    const contentType = asset ? asset.contentType : CONTENT_TYPES[resource as MediaTrack]

    const rangeHeader = request.headers.get('range')
    const range = parseByteRange(rangeHeader, size)
    if (rangeHeader && !range) {
      return new Response(null, { status: 416, headers: { ...CORS_HEADERS, 'Content-Range': `bytes */${size}` } })
    }
    const { start, end } = range ?? { start: 0, end: size - 1 }

    const stream = createReadStream(filePath, { start, end })
    stream.on('error', (error: NodeJS.ErrnoException) => {
      // Players routinely drop a range request mid-way (seeking, closing); that is not a failure.
      if (error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return
      logger.warn('media stream failed', { sessionId, error: String(error) })
    })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` })
      }
    })
  })
}
