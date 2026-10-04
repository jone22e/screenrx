import { access, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { FfmpegService } from '../export/FfmpegService'
import type { SessionStore } from '../recording/SessionStore'

const THUMBNAIL_WIDTH_PX = 640
/** Far enough in to be past a blank first frame, capped for short recordings. */
const POSTER_TIME_S = 1

/**
 * Poster frames for the library. They are derived data, kept in a cache
 * directory outside the sessions, so the recordings themselves stay untouched
 * and the cache can be thrown away at any time.
 */
export class ThumbnailService {
  private readonly pending = new Map<string, Promise<string>>()

  constructor(
    private readonly cacheDirectory: string,
    private readonly ffmpeg: FfmpegService,
    private readonly sessions: SessionStore
  ) {}

  /** Path of the session's poster frame, generating it on first use. */
  thumbnailOf(sessionId: string): Promise<string> {
    let job = this.pending.get(sessionId)
    if (!job) {
      job = this.ensure(sessionId).finally(() => this.pending.delete(sessionId))
      this.pending.set(sessionId, job)
    }
    return job
  }

  /** Forgets the poster of a session that no longer exists. */
  async discard(sessionId: string): Promise<void> {
    await rm(this.pathOf(sessionId), { force: true })
  }

  private pathOf(sessionId: string): string {
    // `screenPathOf` has validated the id by the time this is used for I/O.
    return path.join(this.cacheDirectory, `${sessionId}.jpg`)
  }

  private async ensure(sessionId: string): Promise<string> {
    const screenPath = this.sessions.screenPathOf(sessionId)
    const thumbnailPath = this.pathOf(sessionId)
    try {
      await access(thumbnailPath)
      return thumbnailPath
    } catch {
      // Not generated yet.
    }
    const manifest = await this.sessions.read(sessionId)
    const durationS = (manifest?.assets.screen?.durationMs ?? 0) / 1000
    await mkdir(this.cacheDirectory, { recursive: true })
    // Written under another name first, so a half-written file is never served.
    const partialPath = `${thumbnailPath}.part.jpg`
    await this.ffmpeg.extractFrame(screenPath, partialPath, Math.min(POSTER_TIME_S, durationS / 2), THUMBNAIL_WIDTH_PX)
    await rename(partialPath, thumbnailPath)
    return thumbnailPath
  }
}
