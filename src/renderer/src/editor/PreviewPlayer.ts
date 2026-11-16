import { captionAt } from '@engine/captions/captionCues'
import { textsAt, textsWithMotionAt } from '@engine/captions/textOverlays'
import { dipDarknessAt } from '@engine/time/transitions'
import type { Rect, Size } from '@engine/rendering/frameLayout'
import { outputSizeFor } from '@engine/rendering/frameLayout'
import { safeZones } from '@engine/rendering/safeZones'
import { layersAt } from '@engine/rendering/layerLayout'
import { clickRipplesAt, drawnCursorAt, drawnCursorPath } from '@engine/rendering/cursorRender'
import type { ColorSettings } from '@shared/models/filters'
import type { TimeMap } from '@engine/time/timeMapping'
import { keptSourceTime, nextKeptSourceTime, outputDurationMs, sourceTimeToTimelineTime, timelineTimeToOutputTime } from '@engine/time/timeMapping'
import type { SpeechSpan } from '@engine/audio/musicLevel'
import { approachGain, isSpeakingAt, musicTargetGain } from '@engine/audio/musicLevel'
import { speedAt } from '@engine/timeline/speedConfig'
import { correctTrack } from '@engine/time/trackSync'
import type { Camera } from '@engine/zoom/zoomCamera'
import { cameraAt } from '@engine/zoom/zoomCamera'
import { pointerAt, smoothCursorPath } from '@engine/zoom/cursorPath'
import type { EditorSession } from '@shared/models/editor'
import type { ObjectTrack } from '@shared/models/telemetry'
import type {
  Layer,
  VideoLayer,
  TrimEffect,
  CursorSettings,
  CursorSmoothing,
  SpeedEffect,
  MusicSettings,
  AudioSettings,
  BackgroundSettings,
  CaptionSettings,
  NormalizedPoint,
  TextOverlay,
  WebcamSettings,
  ZoomEffect,
  CaptionStyle
} from '@shared/models/project'
import type { FrameInput } from '../rendering/composeFrame'
import { composeFrame, drawCaption } from '../rendering/composeFrame'

/** The preview canvas never needs more pixels than this, whatever the recording's size. */
const MAX_PREVIEW_WIDTH_PX = 1920

/** The frame around the selected text: dashed, with a square handle at each corner to resize it. */
export const TEXT_SELECTION = {
  /** Side of a corner handle, as a share of the output width (never under the minimum). */
  handleRatio: 0.018,
  minHandlePx: 12,
  /** Room left around the text's block. */
  paddingRatio: 0.02,
  /** How far the frosted panel behind a selected text blurs what is under it, as a share of the output width. */
  blurRatio: 0.008
} as const

/** The handle size and the padded box of the selection, in output pixels. */
export function textSelectionFrame(box: Rect, output: Size): { frame: Rect; handle: number } {
  const padding = output.width * TEXT_SELECTION.paddingRatio
  return {
    frame: { x: box.x - padding, y: box.y - padding, width: box.width + 2 * padding, height: box.height + 2 * padding },
    handle: Math.max(TEXT_SELECTION.minHandlePx, output.width * TEXT_SELECTION.handleRatio)
  }
}

/** The four corners of a frame, where the handles sit. */
export function frameCorners(frame: Rect): Array<{ x: number; y: number }> {
  return [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x, y: frame.y + frame.height },
    { x: frame.x + frame.width, y: frame.y + frame.height }
  ]
}

type Unsubscribe = () => void

/** What the player needs from the project to draw a frame. */
export interface PreviewSettings {
  /** Cuts: playback jumps over anything the map does not keep. */
  timeMap: TimeMap
  zooms: readonly ZoomEffect[]
  /** Stretches played faster or slower, sorted: the preview plays them at their factor, as the export will. */
  speeds: readonly SpeedEffect[]
  /** The cuts, sorted, for the dips at their edges. */
  trims: readonly TrimEffect[]
  background: BackgroundSettings
  webcam: WebcamSettings
  captions: CaptionSettings
  texts: readonly TextOverlay[]
  /** The text picked in the editor: it gets a frame with handles, drawn only here, never exported. */
  selectedTextId: string | null
  /** Images and clips over the video, bottom first, and the one picked in the editor. */
  layers: readonly Layer[]
  selectedLayerId: string | null
  /** Where each image of the session is served from, by file name. */
  images: ReadonlyArray<{ file: string; url: string }>
  /** Where each b-roll clip is served from, and how long it is, by file name. */
  clips: ReadonlyArray<{ file: string; url: string; durationMs: number }>
  /** The drawn pointer's settings; drawn only for recordings made without the system cursor in the picture. */
  cursor: CursorSettings
  /** Whether to shade where a vertical video is covered by the apps' interface; drawn only here. */
  safeAreas: boolean
  /** Whether to draw a phone around a vertical video, with the apps' bars over it; drawn only here. */
  phoneFrame: boolean
  /** Where the marked object goes, for the frame that follows it. */
  objectTrack: ObjectTrack | null
  /** Which audio tracks are heard. */
  audio: AudioSettings
  /** The dubbing heard instead of the recorded voice, when one is in use. */
  dubUrl: string | null
  /** The music under the recording, when there is some and settings for it. */
  music: { url: string; settings: MusicSettings } | null
  /** Where someone speaks, for pressing the music down as the export will. */
  speech: readonly SpeechSpan[]
  /** Global speed of the finished video: the preview plays at it, as the exported file will. */
  speed: number
  /** The screen track to show: the recording, or the one with rendered effects. */
  screenUrl: string
  /** Colour applied to the picture while drawing, as the export does. */
  color: ColorSettings
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
 * separate files that follow it. A track is left alone unless it slips far
 * (`correctTrack`), and then it is seeked: bending its playback rate to catch up
 * is audible as a warble in the sound, and audio always sits a little behind the
 * picture after a start or a seek, so a rate correction would chase that forever.
 */
/** How far the music may stray from the clock before it is seeked. */
const MUSIC_DRIFT_SEC = 0.25
/** How far a b-roll clip may stray from its layer's clock before it is seeked. */
const CLIP_DRIFT_SEC = 0.2

export class PreviewPlayer {
  private readonly video: HTMLVideoElement
  private readonly webcam: HTMLVideoElement | null
  private companions: HTMLMediaElement[]
  /** The dubbing in use; created when one is chosen. */
  private dub: { url: string; element: HTMLAudioElement } | null = null
  /**
   * The music, when there is some. It runs on the finished video's clock, not
   * the recording's: it is kept apart from the companions, which follow the
   * screen track second for second.
   */
  private music: { url: string; element: HTMLAudioElement } | null = null
  /** The music's gain as it is now, smoothed towards what the instant asks for. */
  private musicGain = 0
  private musicClockMs = 0
  private readonly audioTracks: Array<{ kind: 'microphone' | 'systemAudio'; element: HTMLAudioElement }>
  private readonly context: CanvasRenderingContext2D
  /** The pointer's smoothed path, for the frame that follows it; computed once. */
  private readonly cursorPath: NormalizedPoint[]
  /** The marked object's smoothed path, computed again only when a new track arrives. */
  private objectPath: { track: ObjectTrack | null; path: NormalizedPoint[] } = { track: null, path: [] }
  private output: Size
  private settings: PreviewSettings
  private frameRequest = 0
  private destroyed = false
  private drawnCaption: Rect | null = null
  private drawnTexts: Array<{ id: string; box: Rect }> = []
  private drawnLayers: Array<{ id: string; box: Rect }> = []
  /** The session's images as loaded; a file is fetched the first time a layer asks for it. */
  private readonly pictures = new Map<string, HTMLImageElement>()
  /** The b-roll clips, one player each, created the first time a layer shows the clip. */
  private readonly clipPlayers = new Map<string, HTMLVideoElement>()
  /** The pointer's path as drawn, for the smoothing in use; computed again when that changes. */
  private drawnCursor: { smoothing: CursorSmoothing; path: Array<NormalizedPoint | null> } | null = null
  private readonly timeListeners = new Set<(timeMs: number) => void>()
  private readonly playingListeners = new Set<(playing: boolean) => void>()
  private readonly errorListeners = new Set<() => void>()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: EditorSession,
    settings: PreviewSettings
  ) {
    this.settings = settings
    this.cursorPath = smoothCursorPath(session.cursor, session.durationMs)
    this.output = this.outputFor(settings)
    canvas.width = this.output.width
    canvas.height = this.output.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas 2D is unavailable')
    context.imageSmoothingQuality = 'high'
    this.context = context

    this.video = this.createVideo(session.video.url)
    this.video.addEventListener('loadeddata', this.render)
    this.video.addEventListener('loadeddata', () => this.leaveCuts(), { once: true })
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
    this.screenUrl = session.video.url
    this.applyScreenSource()
    this.applyDub()
    this.applyMusic()
    this.applyMutes()
    this.applySpeed()
  }

  /** Which file the screen element is showing. */
  private screenUrl: string

  /**
   * Switches the screen track to the one the settings name (the recording,
   * or the rendered-effects track), staying at the same instant and in the
   * same state of play. The other tracks are not touched: they follow the
   * screen track as they always do.
   */
  private applyScreenSource(): void {
    const url = this.settings.screenUrl
    if (url === this.screenUrl) return
    this.screenUrl = url
    const timeS = this.video.currentTime
    const wasPlaying = this.playing
    const resume = (): void => {
      this.video.removeEventListener('loadedmetadata', resume)
      this.video.currentTime = timeS
      if (wasPlaying) void this.video.play().catch(() => undefined)
    }
    this.video.addEventListener('loadedmetadata', resume)
    this.video.src = url
    this.video.load()
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

  /** Where the pointer is taken to be right now, for the frame that follows it. */
  get pointer(): NormalizedPoint | null {
    return this.cursorPath.length > 0 ? pointerAt(this.cursorPath, this.currentTimeMs) : null
  }

  /** Where the marked object is taken to be right now. */
  get object(): NormalizedPoint | null {
    return this.objectPointAt(this.currentTimeMs)
  }

  private objectPointAt(timeMs: number): NormalizedPoint | null {
    const track = this.settings.objectTrack
    if (!track) return null
    if (this.objectPath.track !== track) {
      this.objectPath = { track, path: smoothCursorPath(track.samples, this.session.durationMs) }
    }
    return this.objectPath.path.length > 0 ? pointerAt(this.objectPath.path, timeMs) : null
  }

  /** The block of the caption currently on screen, in output pixels; `null` when there is none. */
  get captionBox(): Rect | null {
    return this.drawnCaption
  }

  /** The blocks of the texts currently on screen, in output pixels, in drawing order. */
  get textBoxes(): ReadonlyArray<{ id: string; box: Rect }> {
    return this.drawnTexts
  }

  /** The boxes of the images currently on screen, in output pixels, in drawing order. */
  get layerBoxes(): ReadonlyArray<{ id: string; box: Rect }> {
    return this.drawnLayers
  }

  /** Size of the rendered output, for mapping pointer positions. */
  get outputSize(): Size {
    return this.output
  }

  update(settings: PreviewSettings): void {
    const cutsChanged = settings.timeMap !== this.settings.timeMap
    this.settings = settings
    this.applyScreenSource()
    // A paused playhead never stays on a cut stretch: a cut made around it moves it to what is kept.
    if (cutsChanged && !this.playing) this.leaveCuts()
    const output = this.outputFor(settings)
    if (output.width !== this.output.width || output.height !== this.output.height) {
      // A new shape: the canvas is resized, which also clears it, and the next render fills it.
      this.output = output
      this.canvas.width = output.width
      this.canvas.height = output.height
      this.context.imageSmoothingQuality = 'high'
    }
    this.applyDub()
    this.applyMusic()
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

  /** Moves to `timeMs` — or, when that instant is cut, to where the edit resumes. */
  seek(timeMs: number): void {
    const wanted = Math.min(Math.max(timeMs, 0), this.session.durationMs)
    const clamped = keptSourceTime(this.settings.timeMap, wanted) ?? wanted
    this.video.currentTime = clamped / 1000
    for (const companion of this.companions) companion.currentTime = clamped / 1000
    this.placeMusic(clamped, true)
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
    for (const element of [this.video, ...this.companions, ...(this.music ? [this.music.element] : []), ...this.clipPlayers.values()]) {
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
    // The global speed, times the factor of the speed region the playhead is in.
    const speed = this.settings.speed * speedAt(this.settings.speeds, this.currentTimeMs)
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

  /** Loads the music that was chosen, or lets go of the one no longer in use. */
  private applyMusic(): void {
    const url = this.settings.music?.url ?? null
    if (url !== (this.music?.url ?? null)) {
      if (this.music) {
        const previous = this.music.element
        previous.pause()
        previous.removeAttribute('src')
        previous.load()
        this.music = null
      }
      if (url !== null) {
        const element = new Audio(url)
        element.preload = 'auto'
        element.volume = 0
        this.music = { url, element }
        this.musicGain = 0
        this.placeMusic(this.currentTimeMs, true)
        if (this.playing) void element.play().catch(() => undefined)
      }
    }
    if (this.music && this.settings.music) {
      this.music.element.loop = this.settings.music.settings.loop
      this.updateMusicGain(this.currentTimeMs, 0)
    }
  }

  /**
   * Puts the music where it belongs for `sourceMs`: the matching instant of
   * the finished video. Only a seek, or a drift too large to be the clocks'
   * ordinary jitter, moves it — a seek is audible.
   */
  private placeMusic(sourceMs: number, force: boolean): void {
    if (!this.music) return
    const outputSec = this.outputTimeOf(sourceMs) / 1000
    const element = this.music.element
    if (!Number.isFinite(element.duration) || element.duration === 0) {
      element.currentTime = outputSec
      return
    }
    const wanted = element.loop ? outputSec % element.duration : Math.min(outputSec, element.duration)
    if (force || Math.abs(element.currentTime - wanted) > MUSIC_DRIFT_SEC) element.currentTime = wanted
  }

  /** Each frame: follow the clock, and ease the gain towards what the instant asks for. */
  private updateMusicGain(sourceMs: number, elapsedMs: number): void {
    if (!this.music || !this.settings.music) return
    const outputMs = this.outputTimeOf(sourceMs)
    const target = musicTargetGain(
      this.settings.music.settings,
      outputMs,
      outputDurationMs(this.settings.timeMap, this.settings.speed),
      isSpeakingAt(this.settings.speech, sourceMs)
    )
    this.musicGain = elapsedMs === 0 ? target : approachGain(this.musicGain, target, elapsedMs)
    this.music.element.volume = Math.min(Math.max(this.musicGain, 0), 1)
  }

  /** The instant of the finished video that shows `sourceMs`: after the cuts, at the export speed. */
  private outputTimeOf(sourceMs: number): number {
    return timelineTimeToOutputTime(sourceTimeToTimelineTime(this.settings.timeMap, sourceMs), this.settings.speed)
  }

  /** The output in the chosen format, no larger than the preview needs. */
  private outputFor(settings: PreviewSettings): Size {
    const full = outputSizeFor(
      { width: this.session.video.widthPx, height: this.session.video.heightPx },
      settings.background.aspect
    )
    const scale = Math.min(1, MAX_PREVIEW_WIDTH_PX / Math.max(full.width, full.height))
    return { width: Math.round(full.width * scale), height: Math.round(full.height * scale) }
  }

  /** Puts a paused playhead that sits on a cut stretch onto the kept part. */
  private leaveCuts(): void {
    const timeMs = this.currentTimeMs
    const kept = keptSourceTime(this.settings.timeMap, timeMs)
    if (kept !== null && Math.abs(kept - timeMs) > 1) this.seek(kept)
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

    const regions = composeFrame(this.context, this.output, this.frameInputAt(timeMs, showWebcam ? webcam : null))
    this.drawnCaption = regions.caption
    this.drawnTexts = regions.texts
    this.drawnLayers = regions.layers
    const selectedLayer = regions.layers.find((layer) => layer.id === this.settings.selectedLayerId)
    if (selectedLayer) this.drawLayerSelection(selectedLayer.box)
    if (this.settings.safeAreas) this.drawSafeAreas()
    if (this.settings.phoneFrame && this.settings.background.aspect === '9:16') this.drawPhoneFrame()
    const selected = regions.texts.find((text) => text.id === this.settings.selectedTextId)
    const selectedText = selected ? textsAt(this.settings.texts, timeMs).find((text) => text.id === selected.id) : null
    if (selected && selectedText) this.drawTextSelection(selected.box, selectedText)
    if (this.guides.vertical || this.guides.horizontal) this.drawGuides()
    for (const listener of this.timeListeners) listener(timeMs)
  }

  /** Everything `composeFrame` needs for the instant `timeMs`, from the elements as they stand. */
  private frameInputAt(timeMs: number, webcam: HTMLVideoElement | null): FrameInput {
    const { captions } = this.settings
    const caption = captionAt(captions, timeMs)
    return {
      screen: this.video,
      screenSize: { width: this.video.videoWidth, height: this.video.videoHeight },
      webcam: webcam
        ? {
            image: webcam,
            size: { width: webcam.videoWidth, height: webcam.videoHeight },
            settings: this.settings.webcam
          }
        : null,
      camera: cameraAt(this.settings.zooms, timeMs),
      pointer: this.cursorPath.length > 0 ? pointerAt(this.cursorPath, timeMs) : null,
      object: this.objectPointAt(timeMs),
      background: this.settings.background,
      color: this.settings.color,
      caption: caption === null ? null : { text: caption.text, style: captions.style, timing: caption },
      texts: textsWithMotionAt(this.settings.texts, timeMs),
      layers: this.picturesFor(layersAt(this.settings.layers, timeMs)),
      cursor: this.cursorAt(timeMs),
      darkness: dipDarknessAt(this.settings.trims, timeMs)
    }
  }

  /** The drawn pointer at `timeMs`, or `null` for a recording that has the system cursor in the picture, or none at all. */
  private cursorAt(timeMs: number): FrameInput['cursor'] {
    const { cursor } = this.settings
    if (!cursor.visible || this.session.cursorInVideo || this.session.cursor.length === 0) return null
    if (!this.drawnCursor || this.drawnCursor.smoothing !== cursor.smoothing) {
      this.drawnCursor = { smoothing: cursor.smoothing, path: drawnCursorPath(this.session.cursor, this.session.durationMs, cursor.smoothing) }
    }
    return {
      position: drawnCursorAt(this.drawnCursor.path, timeMs),
      settings: cursor,
      ripples: cursor.clickHighlight ? clickRipplesAt(this.session.interactions, timeMs) : []
    }
  }

  /** The images of the layers given, as far as they have loaded; a missing one is fetched and the frame drawn again when it arrives. */
  private picturesFor(layers: readonly Layer[]): FrameInput['layers'] {
    const shown: Array<{ layer: Layer; image: CanvasImageSource; size: Size }> = []
    const timeMs = this.currentTimeMs
    const clipsShown = new Set<string>()
    for (const layer of layers) {
      if (layer.kind === 'video') {
        const clip = this.clipPlayerFor(layer.file)
        if (!clip) continue
        clipsShown.add(layer.file)
        this.placeClip(clip, layer, timeMs)
        if (clip.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && clip.videoWidth > 0) {
          shown.push({ layer, image: clip, size: { width: clip.videoWidth, height: clip.videoHeight } })
        }
        continue
      }
      let picture = this.pictures.get(layer.file)
      if (!picture) {
        const url = this.settings.images.find((image) => image.file === layer.file)?.url
        if (!url) continue
        picture = new Image()
        picture.decoding = 'async'
        picture.addEventListener('load', () => this.render(), { once: true })
        picture.src = url
        this.pictures.set(layer.file, picture)
      }
      if (picture.complete && picture.naturalWidth > 0) {
        shown.push({ layer, image: picture, size: { width: picture.naturalWidth, height: picture.naturalHeight } })
      }
    }
    // A clip no layer shows right now stands still.
    for (const [file, clip] of this.clipPlayers) if (!clipsShown.has(file) && !clip.paused) clip.pause()
    return shown
  }

  /** The player of a b-roll clip, made the first time it is needed. */
  private clipPlayerFor(file: string): HTMLVideoElement | null {
    let clip = this.clipPlayers.get(file)
    if (clip) return clip
    const url = this.settings.clips.find((candidate) => candidate.file === file)?.url
    if (!url) return null
    clip = document.createElement('video')
    clip.muted = true
    clip.playsInline = true
    clip.preload = 'auto'
    clip.src = url
    clip.addEventListener('loadeddata', () => this.render(), { once: true })
    clip.addEventListener('seeked', () => {
      if (!this.playing) this.render()
    })
    this.clipPlayers.set(file, clip)
    return clip
  }

  /** Puts a clip where its layer says for `timeMs`, and plays or pauses it with the recording. */
  private placeClip(clip: HTMLVideoElement, layer: VideoLayer, timeMs: number): void {
    const wantedSec = (layer.offsetMs + (timeMs - layer.startMs)) / 1000
    if (Number.isFinite(clip.duration) && wantedSec >= clip.duration) {
      if (!clip.paused) clip.pause()
      return
    }
    if (Math.abs(clip.currentTime - wantedSec) > CLIP_DRIFT_SEC || !this.playing) {
      if (Math.abs(clip.currentTime - wantedSec) > 0.02) clip.currentTime = wantedSec
    }
    if (this.playing && clip.paused) {
      clip.playbackRate = this.video.playbackRate
      void clip.play().catch(() => undefined)
    } else if (!this.playing && !clip.paused) {
      clip.pause()
    }
  }

  /** A dashed frame with corner handles around the picked image, drawn only on the preview. */
  private drawLayerSelection(box: Rect): void {
    const context = this.context
    const { frame, handle } = textSelectionFrame(box, this.output)
    const line = Math.max(1, this.output.width / 960)
    context.save()
    context.lineWidth = line
    context.setLineDash([4 * line, 4 * line])
    context.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    context.strokeRect(frame.x, frame.y, frame.width, frame.height)
    context.setLineDash([])
    context.fillStyle = '#fff'
    context.shadowColor = 'rgba(0, 0, 0, 0.5)'
    context.shadowBlur = 4 * line
    for (const corner of frameCorners(frame)) {
      context.beginPath()
      context.roundRect(corner.x - handle / 2, corner.y - handle / 2, handle, handle, handle * 0.25)
      context.fill()
    }
    context.restore()
  }

  /**
   * The frame on screen now, drawn again at `size` (the exported video's) as
   * a PNG: a cover for the post. The same drawing as the preview and the
   * export, without the preview's own guides.
   */
  async captureFrame(size: Size): Promise<Blob> {
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw new Error('No frame to capture yet')
    const canvas = new OffscreenCanvas(size.width, size.height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas 2D is unavailable')
    context.imageSmoothingQuality = 'high'
    const webcam = this.webcam
    const showWebcam = webcam !== null && this.settings.webcam.visible && webcam.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    composeFrame(context, size, this.frameInputAt(this.currentTimeMs, showWebcam ? webcam : null))
    return canvas.convertToBlob({ type: 'image/png' })
  }

  /**
   * Marks where the social apps' interface covers a vertical video — on the
   * preview only. Hatched, outlined and named, so they read as guides laid
   * over the picture, not as something wrong with it.
   */
  private drawSafeAreas(): void {
    const context = this.context
    const { width, height } = this.output
    const line = Math.max(1, width / 1080)
    const fontPx = Math.max(11, Math.round(width / 40))
    for (const band of safeZones(this.settings.background.aspect)) {
      const rect = { x: band.x * width, y: band.y * height, width: band.width * width, height: band.height * height }
      context.save()
      context.beginPath()
      context.rect(rect.x, rect.y, rect.width, rect.height)
      context.clip()
      context.fillStyle = 'rgba(0, 0, 0, 0.12)'
      context.fillRect(rect.x, rect.y, rect.width, rect.height)
      // Diagonal hatching, the usual mark for "covered".
      context.strokeStyle = 'rgba(255, 255, 255, 0.28)'
      context.lineWidth = line
      const step = 14 * line
      context.beginPath()
      for (let offset = -rect.height; offset < rect.width + rect.height; offset += step) {
        context.moveTo(rect.x + offset, rect.y + rect.height)
        context.lineTo(rect.x + offset + rect.height, rect.y)
      }
      context.stroke()
      context.restore()

      context.save()
      context.strokeStyle = 'rgba(255, 255, 255, 0.75)'
      context.lineWidth = line
      context.setLineDash([6 * line, 4 * line])
      context.strokeRect(rect.x + line / 2, rect.y + line / 2, rect.width - line, rect.height - line)
      context.restore()

      // The name, at the band's top left, over a small plate so it stays readable on any picture.
      context.save()
      context.font = `600 ${fontPx}px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`
      context.textBaseline = 'middle'
      const padding = fontPx * 0.5
      const textWidth = context.measureText(band.label).width
      const plate = { x: rect.x + padding, y: rect.y + padding, width: textWidth + padding * 1.5, height: fontPx * 1.6 }
      if (plate.width <= rect.width - padding && plate.height <= rect.height - padding) {
        context.fillStyle = 'rgba(0, 0, 0, 0.55)'
        context.beginPath()
        context.roundRect(plate.x, plate.y, plate.width, plate.height, fontPx * 0.35)
        context.fill()
        context.fillStyle = '#fff'
        context.fillText(band.label, plate.x + padding * 0.75, plate.y + plate.height / 2)
      }
      context.restore()
    }
  }

  /** The dashed frame and corner handles around the selected text — on the preview only. */
  /** Centre lines shown while something dragged is snapped to them. */
  private guides = { vertical: false, horizontal: false }

  setGuides(guides: { vertical: boolean; horizontal: boolean }): void {
    if (guides.vertical === this.guides.vertical && guides.horizontal === this.guides.horizontal) return
    this.guides = guides
    this.render()
  }

  /** The output's centre lines, over everything — on the preview only. */
  /**
   * A phone around the vertical video, as the post will be seen: the
   * status bar, the column of buttons and the caption and music lines of
   * the apps, drawn as outlines over the picture. Preview only.
   */
  private drawPhoneFrame(): void {
    const context = this.context
    const { width, height } = this.output
    const unit = width / 1080
    context.save()
    // Rounded screen corners, as a phone has: the corners of the picture go black.
    const radius = 90 * unit
    context.beginPath()
    context.rect(0, 0, width, height)
    context.roundRect(0, 0, width, height, radius)
    context.fillStyle = '#000'
    context.fill('evenodd')
    // Status bar: the time on the left, the battery on the right.
    context.fillStyle = 'rgba(255, 255, 255, 0.92)'
    context.font = `600 ${38 * unit}px system-ui, -apple-system, sans-serif`
    context.textBaseline = 'middle'
    context.textAlign = 'left'
    context.fillText('9:41', 80 * unit, 60 * unit)
    context.strokeStyle = 'rgba(255, 255, 255, 0.92)'
    context.lineWidth = 3 * unit
    context.strokeRect(width - 130 * unit, 44 * unit, 48 * unit, 26 * unit)
    context.fillRect(width - 126 * unit, 48 * unit, 36 * unit, 18 * unit)
    // The column of buttons on the right: heart, comment, share, more.
    const column = width - 90 * unit
    for (const y of [0.52, 0.6, 0.68, 0.76]) {
      context.beginPath()
      context.arc(column, y * height, 34 * unit, 0, Math.PI * 2)
      context.lineWidth = 4 * unit
      context.strokeStyle = 'rgba(255, 255, 255, 0.85)'
      context.stroke()
    }
    // Account name, caption and music lines at the bottom left.
    context.fillStyle = 'rgba(255, 255, 255, 0.85)'
    context.fillRect(60 * unit, 0.84 * height, 260 * unit, 22 * unit)
    context.fillStyle = 'rgba(255, 255, 255, 0.6)'
    context.fillRect(60 * unit, 0.84 * height + 44 * unit, 560 * unit, 18 * unit)
    context.fillRect(60 * unit, 0.84 * height + 78 * unit, 420 * unit, 18 * unit)
    context.fillRect(60 * unit, 0.84 * height + 124 * unit, 300 * unit, 18 * unit)
    // The home indicator.
    context.fillStyle = 'rgba(255, 255, 255, 0.9)'
    context.beginPath()
    context.roundRect(width / 2 - 140 * unit, height - 34 * unit, 280 * unit, 10 * unit, 5 * unit)
    context.fill()
    context.restore()
  }

  private drawGuides(): void {
    const context = this.context
    const { width, height } = this.output
    const line = Math.max(1, width / 960)
    context.save()
    context.lineWidth = line
    context.strokeStyle = 'rgba(255, 80, 200, 0.95)'
    context.shadowColor = 'rgba(0, 0, 0, 0.5)'
    context.shadowBlur = 2 * line
    context.beginPath()
    if (this.guides.vertical) {
      context.moveTo(width / 2, 0)
      context.lineTo(width / 2, height)
    }
    if (this.guides.horizontal) {
      context.moveTo(0, height / 2)
      context.lineTo(width, height / 2)
    }
    context.stroke()
    context.restore()
  }

  /** Scratch canvas for the frosted panel behind a selected text; sized as needed. */
  private scratch: OffscreenCanvas | null = null

  /**
   * The selected text sits on a frosted panel — what is under it blurred and
   * lightened — inside a dashed frame with a handle at each corner, so it
   * reads as the thing being edited. On the preview only: the export never
   * draws it, and it goes as soon as the text is no longer selected.
   */
  private drawTextSelection(box: Rect, text: { text: string; style: CaptionStyle }): void {
    const context = this.context
    const { frame, handle } = textSelectionFrame(box, this.output)
    const line = Math.max(1, this.output.width / 960)
    const blur = Math.max(2, this.output.width * TEXT_SELECTION.blurRatio)
    // A plain rectangle, as the user asked: no rounded corners.
    const panelPath = (): void => {
      context.beginPath()
      context.rect(frame.x, frame.y, frame.width, frame.height)
    }

    // The frosted panel: the picture under the frame, blurred. The blur reads a margin around the
    // frame so its edges are blurred too, and only the frame itself is put back.
    const margin = Math.ceil(blur * 3)
    const sx = Math.max(0, Math.floor(frame.x - margin))
    const sy = Math.max(0, Math.floor(frame.y - margin))
    const sw = Math.min(this.output.width - sx, Math.ceil(frame.width + 2 * margin))
    const sh = Math.min(this.output.height - sy, Math.ceil(frame.height + 2 * margin))
    if (sw > 0 && sh > 0) {
      if (!this.scratch || this.scratch.width < sw || this.scratch.height < sh) this.scratch = new OffscreenCanvas(sw, sh)
      const scratch = this.scratch.getContext('2d')
      if (scratch) {
        scratch.clearRect(0, 0, sw, sh)
        scratch.filter = `blur(${blur}px)`
        scratch.drawImage(this.canvas, sx, sy, sw, sh, 0, 0, sw, sh)
        scratch.filter = 'none'
        context.save()
        panelPath()
        context.clip()
        context.drawImage(this.scratch, 0, 0, sw, sh, sx, sy, sw, sh)
        // A grey veil: what is dark under it comes up a little, what is bright comes down.
        context.fillStyle = 'rgba(128, 128, 128, 0.4)'
        context.fillRect(frame.x, frame.y, frame.width, frame.height)
        context.restore()
        // The text itself, drawn again over the panel, since the blur took it along.
        drawCaption(context, this.output, text.text, text.style)
      }
    }

    context.save()
    context.lineWidth = line
    context.setLineDash([4 * line, 4 * line])
    context.strokeStyle = 'rgba(255, 255, 255, 0.7)'
    panelPath()
    context.stroke()
    context.setLineDash([])
    context.fillStyle = '#fff'
    context.shadowColor = 'rgba(0, 0, 0, 0.5)'
    context.shadowBlur = 4 * line
    for (const corner of frameCorners(frame)) {
      context.beginPath()
      context.roundRect(corner.x - handle / 2, corner.y - handle / 2, handle, handle, handle * 0.25)
      context.fill()
    }
    context.restore()
  }

  private readonly loop = (): void => {
    this.skipCuts()
    this.render()
    this.alignCompanions()
    if (this.settings.speeds.length > 0) this.applySpeed()
    const now = performance.now()
    const sourceMs = this.currentTimeMs
    this.placeMusic(sourceMs, false)
    this.updateMusicGain(sourceMs, this.musicClockMs === 0 ? 0 : now - this.musicClockMs)
    this.musicClockMs = now
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
    const speed = this.video.playbackRate
    for (const companion of this.companions) {
      // A track still landing a seek, still loading, or whose `play()` has not taken yet is not
      // measurable: its clock stands still, and correcting it would only pile up more seeks.
      if (companion.seeking || companion.paused || companion.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        continue
      }
      if (correctTrack(companion.currentTime - time, speed) === 'seek') companion.currentTime = time
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
    if (!playing) for (const clip of this.clipPlayers.values()) clip.pause()
    if (this.music) {
      if (playing) {
        this.placeMusic(this.currentTimeMs, true)
        this.musicClockMs = 0
        void this.music.element.play().catch(() => undefined)
      } else {
        this.music.element.pause()
      }
    }
    if (playing) this.frameRequest = requestAnimationFrame(this.loop)
    for (const listener of this.playingListeners) listener(playing)
  }

  private readonly handleError = (): void => {
    for (const listener of this.errorListeners) listener()
  }
}
