import type { Size } from '@engine/rendering/frameLayout'
import type { TimeMap } from '@engine/time/timeMapping'
import { nextKeptSourceTime } from '@engine/time/timeMapping'
import type { Camera } from '@engine/zoom/zoomCamera'
import { cameraAt } from '@engine/zoom/zoomCamera'
import type { EditorSession } from '@shared/models/editor'
import type { BackgroundSettings, WebcamSettings, ZoomEffect } from '@shared/models/project'
import { composeFrame } from '../rendering/composeFrame'

/** The preview canvas never needs more pixels than this, whatever the recording's size. */
const MAX_PREVIEW_WIDTH_PX = 1920
/** A companion track further than this from the screen track is pulled back in line. */
const MAX_TRACK_DRIFT_S = 0.12

type Unsubscribe = () => void

/** What the player needs from the project to draw a frame. */
export interface PreviewSettings {
  /** Cuts: playback jumps over anything the map does not keep. */
  timeMap: TimeMap
  zooms: readonly ZoomEffect[]
  background: BackgroundSettings
  webcam: WebcamSettings
}

/**
 * Plays the recording into a canvas with the project's effects applied.
 *
 * This is the frame engine: it runs outside React, redraws on its own
 * animation loop, and reports time through callbacks so the UI can follow
 * the playhead without re-rendering components on every frame. Frames are
 * drawn by `composeFrame` with the camera from `cameraAt` — the same code
 * the export will use.
 *
 * The screen track is the master clock; the webcam and the audio tracks are
 * separate files that follow it.
 */
export class PreviewPlayer {
  private readonly video: HTMLVideoElement
  private readonly webcam: HTMLVideoElement | null
  private readonly companions: HTMLMediaElement[]
  private readonly context: CanvasRenderingContext2D
  private readonly output: Size
  private settings: PreviewSettings
  private frameRequest = 0
  private destroyed = false
  private readonly timeListeners = new Set<(timeMs: number) => void>()
  private readonly playingListeners = new Set<(playing: boolean) => void>()
  private readonly errorListeners = new Set<() => void>()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: EditorSession,
    settings: PreviewSettings
  ) {
    this.settings = settings
    const scale = Math.min(1, MAX_PREVIEW_WIDTH_PX / session.video.widthPx)
    this.output = {
      width: Math.round(session.video.widthPx * scale),
      height: Math.round(session.video.heightPx * scale)
    }
    canvas.width = this.output.width
    canvas.height = this.output.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas 2D is unavailable')
    context.imageSmoothingQuality = 'high'
    this.context = context

    this.video = this.createVideo(session.video.url)
    this.video.addEventListener('loadeddata', this.render)
    this.video.addEventListener('seeked', this.render)
    this.video.addEventListener('play', this.handlePlaybackChange)
    this.video.addEventListener('pause', this.handlePlaybackChange)
    this.video.addEventListener('ended', this.handlePlaybackChange)
    this.video.addEventListener('error', this.handleError)

    this.webcam = session.webcam ? this.createVideo(session.webcam.url) : null
    this.webcam?.addEventListener('seeked', this.render)
    this.webcam?.addEventListener('loadeddata', this.render)

    const audio = session.audio.map((track) => {
      const element = new Audio(track.url)
      element.preload = 'auto'
      return element
    })
    this.companions = [...(this.webcam ? [this.webcam] : []), ...audio]
  }

  get currentTimeMs(): number {
    return this.video.currentTime * 1000
  }

  get playing(): boolean {
    return !this.video.paused && !this.video.ended
  }

  /** The camera currently applied to the frame on screen. */
  get camera(): Camera {
    return cameraAt(this.settings.zooms, this.currentTimeMs)
  }

  /** Size of the rendered output, for mapping pointer positions. */
  get outputSize(): Size {
    return this.output
  }

  update(settings: PreviewSettings): void {
    this.settings = settings
    this.render()
  }

  toggle(): void {
    if (this.playing) {
      this.video.pause()
      return
    }
    // From the end of the edit, play again from its beginning.
    const atEnd = this.video.ended || nextKeptSourceTime(this.settings.timeMap, this.currentTimeMs) === null
    if (atEnd) this.seek(nextKeptSourceTime(this.settings.timeMap, 0) ?? 0)
    void this.video.play().catch(() => undefined)
  }

  pause(): void {
    this.video.pause()
  }

  seek(timeMs: number): void {
    const clamped = Math.min(Math.max(timeMs, 0), this.session.durationMs)
    this.video.currentTime = clamped / 1000
    for (const companion of this.companions) companion.currentTime = clamped / 1000
    // Move the playhead at once; the frame follows when the seek completes.
    for (const listener of this.timeListeners) listener(clamped)
  }

  onTime(listener: (timeMs: number) => void): Unsubscribe {
    this.timeListeners.add(listener)
    listener(this.currentTimeMs)
    return () => this.timeListeners.delete(listener)
  }

  onPlayingChange(listener: (playing: boolean) => void): Unsubscribe {
    this.playingListeners.add(listener)
    return () => this.playingListeners.delete(listener)
  }

  onError(listener: () => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  destroy(): void {
    this.destroyed = true
    cancelAnimationFrame(this.frameRequest)
    this.video.removeEventListener('loadeddata', this.render)
    this.video.removeEventListener('seeked', this.render)
    this.video.removeEventListener('play', this.handlePlaybackChange)
    this.video.removeEventListener('pause', this.handlePlaybackChange)
    this.video.removeEventListener('ended', this.handlePlaybackChange)
    this.video.removeEventListener('error', this.handleError)
    this.webcam?.removeEventListener('seeked', this.render)
    this.webcam?.removeEventListener('loadeddata', this.render)
    // Releases the decoders and the streams.
    for (const element of [this.video, ...this.companions]) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
    this.timeListeners.clear()
    this.playingListeners.clear()
    this.errorListeners.clear()
  }

  private createVideo(url: string): HTMLVideoElement {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = url
    return video
  }

  private readonly render = (): void => {
    if (this.destroyed || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const timeMs = this.currentTimeMs
    const webcam = this.webcam
    const showWebcam =
      webcam !== null &&
      this.settings.webcam.visible &&
      webcam.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA

    composeFrame(this.context, this.output, {
      screen: this.video,
      screenSize: { width: this.video.videoWidth, height: this.video.videoHeight },
      webcam: showWebcam
        ? {
            image: webcam,
            size: { width: webcam.videoWidth, height: webcam.videoHeight },
            settings: this.settings.webcam
          }
        : null,
      camera: cameraAt(this.settings.zooms, timeMs),
      background: this.settings.background
    })
    for (const listener of this.timeListeners) listener(timeMs)
  }

  private readonly loop = (): void => {
    this.skipCuts()
    this.render()
    this.alignCompanions()
    if (this.playing && !this.destroyed) this.frameRequest = requestAnimationFrame(this.loop)
  }

  /** While playing, a cut is never shown: playback continues where the edit resumes. */
  private skipCuts(): void {
    const timeMs = this.currentTimeMs
    const resumeAt = nextKeptSourceTime(this.settings.timeMap, timeMs)
    if (resumeAt === null) {
      // Nothing is kept from here to the end of the recording.
      this.video.pause()
    } else if (resumeAt > timeMs) {
      this.seek(resumeAt)
    }
  }

  /** Keeps the separately recorded tracks in step with the screen track. */
  private alignCompanions(): void {
    const time = this.video.currentTime
    for (const companion of this.companions) {
      if (Math.abs(companion.currentTime - time) > MAX_TRACK_DRIFT_S) companion.currentTime = time
    }
  }

  private readonly handlePlaybackChange = (): void => {
    cancelAnimationFrame(this.frameRequest)
    const playing = this.playing
    for (const companion of this.companions) {
      if (playing) {
        companion.currentTime = this.video.currentTime
        void companion.play().catch(() => undefined)
      } else {
        companion.pause()
      }
    }
    if (playing) this.frameRequest = requestAnimationFrame(this.loop)
    for (const listener of this.playingListeners) listener(playing)
  }

  private readonly handleError = (): void => {
    for (const listener of this.errorListeners) listener()
  }
}
