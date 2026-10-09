import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import type { MediaTrack } from '@shared/models/media'
import { MEDIA_SCHEME, isMediaTrack } from '@shared/models/media'
import { isSessionId } from '@shared/models/session'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import type { ThumbnailService } from './ThumbnailService'
import { parseByteRange } from './byteRange'

const CONTENT_TYPES: Record<MediaTrack, string> = {
  dubEn: 'audio/mp4',
  dubEs: 'audio/mp4',
  dubZh: 'audio/mp4',
  dubPt: 'audio/mp4',
  screen: 'video/mp4',
  screenFx: 'video/mp4',
  webcam: 'video/mp4',
  microphone: 'audio/mp4',
  systemAudio: 'audio/mp4'
}

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }
  ])
}

/**
 * Streams recorded media to the renderers as `screenrx-media://session/<id>/<track>`,
 * and each session's poster frame as `…/<id>/thumbnail`.
 * The renderer names a session, never a path, and the file is served in
 * ranges straight from disk — a long recording is never loaded into memory.
 */
export function serveMedia(sessions: SessionStore, thumbnails: ThumbnailService, logger: Logger): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const [sessionId, resource] = url.pathname.split('/').filter(Boolean)
    if (url.hostname !== 'session' || !isSessionId(sessionId)) {
      return new Response(null, { status: 404 })
    }

    if (resource === 'thumbnail') {
      try {
        return new Response(await readFile(await thumbnails.thumbnailOf(sessionId)), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' }
        })
      } catch (error) {
        logger.warn('no thumbnail', { sessionId, error: String(error) })
        return new Response(null, { status: 404 })
      }
    }
    if (!isMediaTrack(resource)) return new Response(null, { status: 404 })

    let filePath: string
    let size: number
    try {
      filePath = sessions.trackPathOf(sessionId, resource)
      size = (await stat(filePath)).size
    } catch {
      return new Response(null, { status: 404 })
    }

    const rangeHeader = request.headers.get('range')
    const range = parseByteRange(rangeHeader, size)
    if (rangeHeader && !range) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
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
        'Content-Type': CONTENT_TYPES[resource],
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` })
      }
    })
  })
}
