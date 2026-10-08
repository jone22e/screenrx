import { captionAt } from '@engine/captions/captionCues'
import type { Rect, Size } from '@engine/rendering/frameLayout'
import type { TimeMap } from '@engine/time/timeMapping'
import { nextKeptSourceTime } from '@engine/time/timeMapping'
import { correctTrack } from '@engine/time/trackSync'
import type { Camera } from '@engine/zoom/zoomCamera'
import { cameraAt } from '@engine/zoom/zoomCamera'
import type { EditorSession } from '@shared/models/editor'
import type {
  AudioSettings,
  BackgroundSettings,
  CaptionSettings,
  WebcamSettings,
  ZoomEffect
} from '@shared/models/project'
import { composeFrame } from '../rendering/composeFrame'

/** The preview canvas never needs more pixels than this, whatever the recording's size. */
const MAX_PREVIEW_WIDTH_PX = 1920

type Unsubscribe = () => void

/** What the player needs from the project to draw a frame. */
export interface PreviewSettings {
  /** Cuts: playback jumps over anything the map does not keep. */
  timeMap: TimeMap
  zooms: readonly ZoomEffect[]
  background: BackgroundSettings
  webcam: WebcamSettings
  captions: CaptionSettings
  /** Which audio tracks are heard. */
  audio: AudioSettings
  /** The dubbing heard instead of the recorded voice, when one is in use. */
  dubUrl: string | null
  /** Global speed of the finished video: the preview plays at it, as the exported file will. */
  speed: number
}

/**
 * Plays the recording into a canvas with the project's effects applied.
 *
 * This is the frame engine: it runs outside React, redraws on its own
 * animation loop, and reports time through callbacks so the UI can follow
 * the playhead without re-rendering components on every frame. Frames are
 * drawn by `composeFrame` with the camera from `cameraAt` and the caption
 * from `cueAt` — the same code the export uses.
 *
 * The screen track is the master clock; the webcam and the audio tracks are
 * separate files that follow it. A track that slips a little is bent back by
 * its playback rate (`correctTrack`), never by a seek: seeking an audio element
 * is heard as a cut in the sound, and a seek on every frame made playback stutter.
 */
export class PreviewPlayer {
  private readonly video: HTMLVideoElement
  private readonly webcam: HTMLVideoElement | null
  private companions: HTMLMediaElement[]
  /** The dubbing in use; created when one is chosen. */
  private dub: { url: string; element: HTMLAudioElement } | null = null
  private readonly audioTracks: Array<{ kind: 'microphone' | 'systemAudio'; element: HTMLAudioElement }>
  private readonly context: CanvasRenderingContext2D
  private readonly output: Size
  private settings: PreviewSettings
  private frameRequest = 0
  private destroyed = false
  private drawnCaption: Rect | null = null
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

    this.audioTracks = session.audio.map((track) => {
      const element = new Audio(track.url)
      element.preload = 'auto'
      return { kind: track.kind, element }
    })
    this.companions = [...(this.webcam ? [this.webcam] : []), ...this.audioTracks.map((track) => track.element)]
    this.applyDub()
    this.applyMutes()
    this.applySpeed()
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

  /** The block of the caption currently on screen, in output pixels; `null` when there is none. */
  get captionBox(): Rect | null {
    return this.drawnCaption
  }

  /** Size of the rendered output, for mapping pointer positions. */
  get outputSize(): Size {
    return this.output
  }

  update(settings: PreviewSettings): void {
    this.settings = settings
    this.applyDub()
    this.applyMutes()
    this.applySpeed()
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

  /**
   * A muted track keeps playing in step with the others, silently, so unmuting
   * is instant. A dubbing in use takes the place of the recorded voice.
   */
  private applyMutes(): void {
    for (const track of this.audioTracks) {
      const replaced = track.kind === 'microphone' && this.dub !== null
      track.element.muted = replaced || this.settings.audio[track.kind].muted
    }
  }

  /**
   * Every track plays at the speed of the finished video. Voices keep their
   * pitch (the media elements' default), as they do in the exported file.
   */
  private applySpeed(): void {
    const { speed } = this.settings
    for (const element of [this.video, ...this.companions]) {
      // Both: loading a source puts the rate back to the default one.
      if (element.defaultPlaybackRate !== speed) element.defaultPlaybackRate = speed
      if (element.playbackRate !== speed) element.playbackRate = speed
    }
  }

  /** Loads the dubbing that was chosen, or lets go of the one no longer in use. */
  private applyDub(): void {
    const url = this.settings.dubUrl
    if (url === (this.dub?.url ?? null)) return
    if (this.dub) {
      const previous = this.dub.element
      previous.pause()
      previous.removeAttribute('src')
      previous.load()
      this.companions = this.companions.filter((element) => element !== previous)
      this.dub = null
    }
    if (url === null) return
    const element = new Audio(url)
    element.preload = 'auto'
    element.currentTime = this.video.currentTime
    this.dub = { url, element }
    this.companions = [...this.companions, element]
    if (this.playing) void element.play().catch(() => undefined)
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

    const { captions } = this.settings
    const caption = captionAt(captions, timeMs)

    const regions = composeFrame(this.context, this.output, {
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
      background: this.settings.background,
      caption: caption === null ? null : { text: caption, style: captions.style }
    })
    this.drawnCaption = regions.caption
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
    const { speed } = this.settings
    for (const companion of this.companions) {
      // A track still landing a seek, still loading, or whose `play()` has not taken yet is not
      // measurable: its clock stands still, and correcting it would only pile up more seeks.
      if (companion.seeking || companion.paused || companion.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        continue
      }
      const correction = correctTrack(companion.currentTime - time, speed)
      if (correction.kind === 'seek') {
        companion.currentTime = time
        if (companion.playbackRate !== speed) companion.playbackRate = speed
      } else if (companion.playbackRate !== correction.rate) {
        companion.playbackRate = correction.rate
      }
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
