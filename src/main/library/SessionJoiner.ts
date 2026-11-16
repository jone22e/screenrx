import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { RecordingSessionManifest, SessionDiagnostic } from '@shared/models/session'
import type { CursorSample, InteractionEvent } from '@shared/models/telemetry'
import { parseCursorSamples, parseInteractions } from '@shared/models/telemetry'
import type { FfmpegService } from '../export/FfmpegService'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class JoinError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'JoinError'
  }
}

export interface SessionJoinerDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
  now?: () => Date
}

/** One recording as it goes into the joined one: where its part starts, and how it was fitted into the first one's frame. */
interface Part {
  manifest: RecordingSessionManifest
  startMs: number
  durationMs: number
  /** Where the part's picture sits in the joined frame, as shares of it, after being fitted. */
  fit: { x: number; y: number; width: number; height: number }
}

const MAX_PARTS = 20

/**
 * Joins several recordings into a new one, in the order given: the screen
 * tracks one after the other, fitted into the first recording's frame; the
 * microphone and system tracks likewise, with silence where a recording has
 * none; the pointer telemetry shifted in time and into the fitted frame, so
 * automatic zooms and the drawn cursor still work. The parts are not
 * touched. The result is an ordinary recording that opens in the editor,
 * where cuts, captions and everything else apply to the whole.
 */
export class SessionJoiner {
  constructor(private readonly deps: SessionJoinerDeps) {}

  /** Joins the recordings and returns the new session's id; throws a `JoinError` when it cannot. */
  async join(sessionIds: readonly string[]): Promise<string> {
    const { ffmpeg, sessions, logger } = this.deps
    if (sessionIds.length < 2 || sessionIds.length > MAX_PARTS) throw new JoinError(appError('invalid-state', 'join needs 2 to 20 recordings'))
    const manifests: RecordingSessionManifest[] = []
    for (const sessionId of sessionIds) {
      const manifest = await sessions.read(sessionId)
      if (!manifest || manifest.status !== 'completed' || !manifest.assets.screen) {
        throw new JoinError(appError('recording-invalid', `recording ${sessionId} cannot be joined`))
      }
      manifests.push(manifest)
    }
    const first = manifests[0] as RecordingSessionManifest
    const frame = { width: first.assets.screen!.widthPx, height: first.assets.screen!.heightPx }
    const fps = Math.max(...manifests.map((manifest) => manifest.capture.fps))

    let startMs = 0
    const parts: Part[] = manifests.map((manifest) => {
      const screen = manifest.assets.screen!
      const scale = Math.min(frame.width / screen.widthPx, frame.height / screen.heightPx)
      const width = screen.widthPx * scale
      const height = screen.heightPx * scale
      const part: Part = {
        manifest,
        startMs,
        durationMs: screen.durationMs,
        fit: { x: (frame.width - width) / 2 / frame.width, y: (frame.height - height) / 2 / frame.height, width: width / frame.width, height: height / frame.height }
      }
      startMs += screen.durationMs
      return part
    })

    const title = manifests.map((manifest) => manifest.title ?? manifest.source.label).join(' + ')
    const created = await sessions.create(
      { source: { kind: 'file', label: title, displayId: null, windowId: null, appName: null }, fps, cursorInVideo: manifests.some((m) => m.capture.cursorInVideo) },
      (this.deps.now ?? (() => new Date()))()
    )
    const sessionId = created.manifest.id
    logger.info('joining recordings', { sessionId, parts: sessionIds, size: `${frame.width}x${frame.height}` })

    try {
      await ffmpeg.concatVideos(
        parts.map((part) => ({ path: sessions.trackPathOf(part.manifest.id, 'screen') })),
        created.screenPath,
        { width: frame.width, height: frame.height, fps, bitrate: Math.round(frame.width * frame.height * fps * EXPORT_CONFIG.bitsPerPixelPerFrame) }
      )
      const audioAssets: Partial<Pick<RecordingSessionManifest['assets'], 'microphone' | 'systemAudio'>> = {}
      for (const kind of ['microphone', 'systemAudio'] as const) {
        if (!manifests.some((manifest) => manifest.assets[kind])) continue
        const outputPath = kind === 'microphone' ? created.microphonePath : created.systemAudioPath
        await ffmpeg.concatAudio(
          parts.map((part) => ({ path: part.manifest.assets[kind] ? sessions.trackPathOf(part.manifest.id, kind) : null, durationMs: part.durationMs })),
          outputPath
        )
        audioAssets[kind] = {
          file: SESSION_FILES[kind],
          sizeBytes: (await stat(outputPath)).size,
          durationMs: Math.round(await ffmpeg.durationOf(outputPath)),
          ...(kind === 'microphone' && { deviceName: 'Gravações juntadas' })
        }
      }

      const telemetry = await this.joinTelemetry(parts, created.cursorPath, created.interactionsPath)
      const [packets, screenSize, screen] = await Promise.all([
        ffmpeg.probeVideoPackets(created.screenPath),
        stat(created.screenPath),
        ffmpeg.probeMedia(created.screenPath)
      ])
      if (!screen.video || packets.length === 0) throw new JoinError(appError('import-failed', 'joined track has no decodable frames'))
      const diagnostics: SessionDiagnostic[] = telemetry
        ? []
        : [{ level: 'info', code: 'telemetry-missing', message: 'Joined recording: no pointer telemetry in any part, so automatic zooms are unavailable.' }]
      await sessions.write({
        ...created.manifest,
        status: 'completed',
        clock: { durationMs: screen.durationMs, pauses: [] },
        assets: {
          screen: {
            file: SESSION_FILES.screen,
            sizeBytes: screenSize.size,
            durationMs: screen.durationMs,
            widthPx: screen.video.widthPx,
            heightPx: screen.video.heightPx,
            frameCount: packets.length,
            droppedFrameCount: 0
          },
          ...audioAssets,
          ...(telemetry ?? {})
        },
        diagnostics
      })
      logger.info('recordings joined', { sessionId, durationMs: screen.durationMs })
      return sessionId
    } catch (error) {
      await rm(created.directory, { recursive: true, force: true })
      logger.error('join failed', { sessionId, error: String(error) })
      throw error instanceof JoinError ? error : new JoinError(appError('import-failed', String(error)))
    }
  }

  /** The parts' cursor samples and clicks, shifted in time and into the fitted frame; `null` when no part has any. */
  private async joinTelemetry(
    parts: readonly Part[],
    cursorPath: string,
    interactionsPath: string
  ): Promise<Pick<RecordingSessionManifest['assets'], 'cursor' | 'interactions'> | null> {
    const { sessions } = this.deps
    const cursor: CursorSample[] = []
    const interactions: InteractionEvent[] = []
    let any = false
    for (const part of parts) {
      const { manifest, startMs, fit } = part
      const place = <T extends { timeMs: number; x: number; y: number }>(entry: T): T => ({
        ...entry,
        timeMs: entry.timeMs + startMs,
        x: fit.x + entry.x * fit.width,
        y: fit.y + entry.y * fit.height
      })
      if (manifest.assets.cursor) {
        any = true
        const raw = await readFile(path.join(sessions.directoryOf(manifest.id), manifest.assets.cursor.file), 'utf8').catch(() => '[]')
        cursor.push(...parseCursorSamples(JSON.parse(raw)).filter((sample) => sample.timeMs <= part.durationMs).map(place))
      }
      if (manifest.assets.interactions) {
        any = true
        const raw = await readFile(path.join(sessions.directoryOf(manifest.id), manifest.assets.interactions.file), 'utf8').catch(() => '[]')
        interactions.push(...parseInteractions(JSON.parse(raw)).filter((event) => event.timeMs <= part.durationMs).map(place))
      }
    }
    if (!any) return null
    await writeJsonAtomic(cursorPath, cursor)
    await writeJsonAtomic(interactionsPath, interactions)
    return {
      cursor: { file: SESSION_FILES.cursor, entryCount: cursor.length },
      interactions: { file: SESSION_FILES.interactions, entryCount: interactions.length }
    }
  }
}

export function toJoinAppError(error: unknown): AppError {
  return error instanceof JoinError ? error.appError : appError('import-failed', String(error))
}
