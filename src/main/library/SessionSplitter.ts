import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { SESSION_FILES } from '@shared/config/recording'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { RecordingSessionManifest } from '@shared/models/session'
import type { SeriesEpisode, SeriesPlan, SeriesProgress } from '@shared/models/series'
import { parseCursorSamples, parseInteractions } from '@shared/models/telemetry'
import type { FfmpegService } from '../export/FfmpegService'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'

export class SplitError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'SplitError'
  }
}

export interface SessionSplitterDeps {
  ffmpeg: FfmpegService
  sessions: SessionStore
  logger: Logger
  onProgress?: (progress: SeriesProgress) => void
  now?: () => Date
}

/**
 * Makes a series out of one recording: each episode becomes a recording of
 * its own, with its stretch of the screen, microphone and system tracks cut
 * out (the webcam too), the pointer telemetry and the transcript shifted to start at zero,
 * the episode's title as its name and the series' name on it. Each episode
 * starts on the keyframe at or before where the plan says, so the video is
 * copied rather than re-encoded (seconds instead of minutes, same picture,
 * same size), and ends where the next one starts. The source recording is
 * not touched. Episodes are made one after the other; a failure removes the
 * ones already made.
 */
export class SessionSplitter {
  constructor(private readonly deps: SessionSplitterDeps) {}

  /** Makes the episodes and returns their ids, in order; throws a `SplitError` when it cannot. */
  async split(sessionId: string, plan: SeriesPlan): Promise<string[]> {
    const { sessions, logger } = this.deps
    const manifest = await sessions.read(sessionId)
    const screen = manifest?.assets.screen
    if (!manifest || manifest.status !== 'completed' || !screen) throw new SplitError(appError('recording-invalid', `recording ${sessionId} cannot be split`))
    if (plan.episodes.length === 0) throw new SplitError(appError('invalid-state', 'no episodes'))
    const episodes = await this.onKeyframes(manifest, plan.episodes)
    const made: Array<{ id: string; directory: string }> = []
    logger.info('splitting recording', { sessionId, series: plan.seriesTitle, episodes: episodes.length })
    try {
      for (const [index, episode] of episodes.entries()) {
        this.deps.onProgress?.({ sessionId, done: index, total: episodes.length, title: episode.title })
        made.push(await this.makeEpisode(manifest, episode, index, plan))
      }
      this.deps.onProgress?.({ sessionId, done: plan.episodes.length, total: plan.episodes.length, title: '' })
      await sessions.addSeries(plan.seriesTitle)
      logger.info('recording split', { sessionId, episodes: made.map((entry) => entry.id) })
      return made.map((entry) => entry.id)
    } catch (error) {
      for (const entry of made) await rm(entry.directory, { recursive: true, force: true })
      logger.error('split failed', { sessionId, error: String(error) })
      throw error instanceof SplitError ? error : new SplitError(appError('import-failed', String(error)))
    }
  }

  /**
   * The episodes moved onto the screen track's keyframes: each starts on the
   * keyframe at or before its planned start (the first at 0), ends where the
   * next starts, and the last runs to the end. Two that land on the same
   * keyframe become one.
   */
  private async onKeyframes(source: RecordingSessionManifest, planned: readonly SeriesEpisode[]): Promise<SeriesEpisode[]> {
    const { ffmpeg, sessions } = this.deps
    const durationMs = source.assets.screen!.durationMs
    const keyframes = (await ffmpeg.probeVideoPackets(sessions.trackPathOf(source.id, 'screen'))).filter((packet) => packet.keyframe).map((packet) => packet.timestampUs / 1000)
    const snap = (timeMs: number): number => keyframes.reduce((best, time) => (time <= timeMs + 1 && time > best ? time : best), 0)
    const episodes: SeriesEpisode[] = []
    for (const [index, episode] of planned.entries()) {
      const startMs = index === 0 ? 0 : snap(episode.startMs)
      const previous = episodes.at(-1)
      if (previous && startMs <= previous.startMs) continue
      if (previous) previous.endMs = startMs
      episodes.push({ startMs, endMs: durationMs, title: episode.title })
    }
    return episodes
  }

  private async makeEpisode(source: RecordingSessionManifest, episode: SeriesEpisode, index: number, plan: SeriesPlan): Promise<{ id: string; directory: string }> {
    const { ffmpeg, sessions } = this.deps
    const wantedMs = episode.endMs - episode.startMs
    const title = `${index + 1}. ${episode.title}`
    const created = await sessions.create(
      { source: { ...source.source, label: title }, fps: source.capture.fps, cursorInVideo: source.capture.cursorInVideo },
      // Episodes made in the same second would share an id: each is stamped a little later than the one before.
      new Date((this.deps.now ?? (() => new Date()))().getTime() + index * 1000)
    )
    await ffmpeg.cutVideo(sessions.trackPathOf(source.id, 'screen'), created.screenPath, episode.startMs, wantedMs, { copy: true })
    const [packets, screenSize, probe] = await Promise.all([ffmpeg.probeVideoPackets(created.screenPath), stat(created.screenPath), ffmpeg.probeMedia(created.screenPath)])
    if (!probe.video || packets.length === 0) throw new SplitError(appError('import-failed', 'episode has no decodable frames'))
    const durationMs = probe.durationMs

    const audioAssets: Partial<Pick<RecordingSessionManifest['assets'], 'microphone' | 'systemAudio'>> = {}
    for (const kind of ['microphone', 'systemAudio'] as const) {
      const asset = source.assets[kind]
      if (!asset) continue
      const outputPath = kind === 'microphone' ? created.microphonePath : created.systemAudioPath
      await ffmpeg.cutAudio(sessions.trackPathOf(source.id, kind), outputPath, episode.startMs, wantedMs)
      audioAssets[kind] = {
        file: SESSION_FILES[kind],
        sizeBytes: (await stat(outputPath)).size,
        durationMs: Math.round(await ffmpeg.durationOf(outputPath)),
        ...(kind === 'microphone' && { deviceName: asset.deviceName })
      }
    }

    // The webcam has keyframes of its own, so its stretch is re-encoded to start exactly with the screen's.
    let webcam: RecordingSessionManifest['assets']['webcam']
    if (source.assets.webcam) {
      const camera = source.assets.webcam
      const bitrate = Math.round(camera.widthPx * camera.heightPx * source.capture.fps * EXPORT_CONFIG.bitsPerPixelPerFrame)
      await ffmpeg.cutVideo(sessions.trackPathOf(source.id, 'webcam'), created.webcamPath, episode.startMs, wantedMs, { copy: false, bitrate })
      const [size, probed] = await Promise.all([stat(created.webcamPath), ffmpeg.probeMedia(created.webcamPath)])
      if (probed.video) {
        webcam = { file: SESSION_FILES.webcam, sizeBytes: size.size, durationMs: probed.durationMs, widthPx: probed.video.widthPx, heightPx: probed.video.heightPx, deviceName: camera.deviceName }
      }
    }

    const telemetry = await this.sliceTelemetry(source, episode, created.cursorPath, created.interactionsPath)
    await this.sliceTranscript(source, episode, created.directory)
    await sessions.write({
      ...created.manifest,
      title,
      series: plan.seriesTitle,
      status: 'completed',
      clock: { durationMs, pauses: [] },
      assets: {
        screen: {
          file: SESSION_FILES.screen,
          sizeBytes: screenSize.size,
          durationMs,
          widthPx: probe.video.widthPx,
          heightPx: probe.video.heightPx,
          frameCount: packets.length,
          droppedFrameCount: 0
        },
        ...audioAssets,
        ...(webcam && { webcam }),
        ...(telemetry ?? {})
      },
      diagnostics: []
    })
    return { id: created.manifest.id, directory: created.directory }
  }

  /** The source's pointer samples and clicks inside the episode, shifted to start at zero; `null` when the source has none. */
  private async sliceTelemetry(
    source: RecordingSessionManifest,
    episode: SeriesEpisode,
    cursorPath: string,
    interactionsPath: string
  ): Promise<Pick<RecordingSessionManifest['assets'], 'cursor' | 'interactions'> | null> {
    const { sessions } = this.deps
    if (!source.assets.cursor && !source.assets.interactions) return null
    const inside = <T extends { timeMs: number }>(entry: T): boolean => entry.timeMs >= episode.startMs && entry.timeMs <= episode.endMs
    const shift = <T extends { timeMs: number }>(entry: T): T => ({ ...entry, timeMs: entry.timeMs - episode.startMs })
    const read = async (file: string | undefined): Promise<unknown> =>
      file ? JSON.parse(await readFile(path.join(sessions.directoryOf(source.id), file), 'utf8').catch(() => '[]')) : []
    const cursor = parseCursorSamples(await read(source.assets.cursor?.file)).filter(inside).map(shift)
    const interactions = parseInteractions(await read(source.assets.interactions?.file)).filter(inside).map(shift)
    await writeJsonAtomic(cursorPath, cursor)
    await writeJsonAtomic(interactionsPath, interactions)
    return {
      cursor: { file: SESSION_FILES.cursor, entryCount: cursor.length },
      interactions: { file: SESSION_FILES.interactions, entryCount: interactions.length }
    }
  }

  /** The words said during the episode, shifted to start at zero, so captions are ready without transcribing again. */
  private async sliceTranscript(source: RecordingSessionManifest, episode: SeriesEpisode, directory: string): Promise<void> {
    const transcript = await this.deps.sessions.readTranscript(source.id)
    if (!transcript) return
    const words = transcript.words
      .filter((word) => word.startMs >= episode.startMs && word.startMs < episode.endMs)
      .map((word) => ({ ...word, startMs: word.startMs - episode.startMs, endMs: Math.min(word.endMs, episode.endMs) - episode.startMs }))
    if (words.length === 0) return
    await writeJsonAtomic(path.join(directory, SESSION_FILES.transcript), { ...transcript, words })
  }
}

export function toSplitAppError(error: unknown): AppError {
  return error instanceof SplitError ? error.appError : appError('import-failed', String(error))
}
