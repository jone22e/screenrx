import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer'

/**
 * Screen recording in the browser: the screen (or a window, or a tab) the
 * user picks, with the microphone and the sound the browser lets us hear,
 * encoded as it is captured into an MP4 the editor opens at once. No
 * telemetry (cursor, clicks) comes with it: that is the desktop app's.
 */

export class WebRecorderError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'WebRecorderError'
  }
}

export interface WebRecordingOptions {
  microphone: boolean
  systemAudio: boolean
  /** Where to write as it records; in memory when `null` (the file is then also downloaded). */
  handle: FileSystemFileHandle | null
}

export interface WebRecording {
  file: File
  handle: FileSystemFileHandle | null
  durationMs: number
}

/** Frames per second asked of the capture, and of the encoder. */
const FPS = 30
const KEYFRAME_INTERVAL_US = 2_000_000
/** Frames waiting in the encoder before new ones are dropped, so a slow machine falls behind instead of swelling. */
const MAX_QUEUED_FRAMES = 8
/** A still screen sends no frames; the last one is repeated this often so the file keeps a steady beat. */
const STILL_FRAME_INTERVAL_MS = 1000
const AUDIO_BITRATE = 128_000

type Target = ArrayBufferTarget | FileSystemWritableFileStreamTarget

/** Whether this browser can record here: screen capture, WebCodecs and the track reader. */
export function canRecordInBrowser(): boolean {
  return (
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    window.isSecureContext
  )
}

/** Bits per second for screen content of this size: ~6 Mb/s at 1080p, bounded for tiny and huge pictures. */
const videoBitrateFor = (width: number, height: number): number => Math.round(Math.min(20_000_000, Math.max(1_500_000, width * height * FPS * 0.1)))

interface Active {
  display: MediaStream
  microphone: MediaStream | null
  audioContext: AudioContext | null
  /** The mix of everything heard, as a track of its own; stopped with the rest. */
  mixedTrack: MediaStreamTrack | null
  videoEncoder: VideoEncoder | null
  audioEncoder: AudioEncoder | null
  muxer: Muxer<Target> | null
  target: Target | null
  writable: FileSystemWritableFileStream | null
  handle: FileSystemFileHandle | null
  readers: Array<ReadableStreamDefaultReader<VideoFrame | AudioData>>
  stopping: boolean
  failure: Error | null
  startedAt: number
  width: number
  height: number
}

export class WebRecorder {
  private active: Active | null = null
  private finished: Promise<void> | null = null
  private settle: (() => void) | null = null
  private readonly listeners = new Set<() => void>()

  /** Told when the capture ends on its own (the browser's "stop sharing"). */
  onEnded(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get recording(): boolean {
    return this.active !== null
  }

  /**
   * Asks for the screen (the browser shows its picker) and the microphone,
   * then records until `stop`. Throws `WebRecorderError`; a cancelled picker
   * is `recording-cancelled`.
   */
  async start(options: WebRecordingOptions): Promise<void> {
    if (this.active) throw new WebRecorderError(appError('invalid-state', 'already recording'))
    if (!canRecordInBrowser()) throw new WebRecorderError(appError('platform-unsupported', 'no screen capture or WebCodecs in this browser'))

    let display: MediaStream
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: FPS } },
        audio: options.systemAudio,
        // Chromium extras: keep the picker from offering this very tab, let the user switch surfaces.
        ...({ selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include' } as object)
      })
    } catch (error) {
      if ((error as DOMException).name === 'NotAllowedError') throw new WebRecorderError(appError('no-source-selected'))
      throw new WebRecorderError(appError('capture-failed', String(error)))
    }
    let microphone: MediaStream | null = null
    if (options.microphone) {
      try {
        microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      } catch (error) {
        display.getTracks().forEach((track) => track.stop())
        throw new WebRecorderError(appError('microphone-permission-denied', String(error)))
      }
    }

    const active: Active = {
      display,
      microphone,
      audioContext: null,
      mixedTrack: null,
      videoEncoder: null,
      audioEncoder: null,
      muxer: null,
      target: null,
      writable: null,
      handle: options.handle,
      readers: [],
      stopping: false,
      failure: null,
      startedAt: performance.now(),
      width: 0,
      height: 0
    }
    this.active = active
    this.finished = new Promise((resolve) => {
      this.settle = resolve
    })

    const videoTrack = display.getVideoTracks()[0]
    if (!videoTrack) {
      this.release(active)
      throw new WebRecorderError(appError('capture-failed', 'no video track'))
    }
    videoTrack.addEventListener('ended', () => {
      if (this.active === active && !active.stopping) for (const listener of this.listeners) listener()
    })

    // Everything heard goes through one mix, so the file has a single stereo track.
    const audioTracks = [...display.getAudioTracks(), ...(microphone?.getAudioTracks() ?? [])]
    let mixedTrack: MediaStreamTrack | null = null
    if (audioTracks.length > 0 && typeof AudioEncoder !== 'undefined') {
      const context = new AudioContext({ sampleRate: EXPORT_CONFIG.audioSampleRate })
      const destination = context.createMediaStreamDestination()
      destination.channelCount = 2
      for (const track of audioTracks) context.createMediaStreamSource(new MediaStream([track])).connect(destination)
      active.audioContext = context
      mixedTrack = destination.stream.getAudioTracks()[0] ?? null
      active.mixedTrack = mixedTrack
    }

    try {
      active.writable = options.handle ? await options.handle.createWritable() : null
    } catch (error) {
      this.release(active)
      throw new WebRecorderError(appError('storage-unavailable', String(error)))
    }
    active.target = active.writable ? new FileSystemWritableFileStreamTarget(active.writable) : new ArrayBufferTarget()

    void this.pump(active, videoTrack, mixedTrack)
  }

  /** The pieces are set up on the first frame, whose size the file takes; later frames of another size are fitted into it. */
  private async pump(active: Active, videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack | null): Promise<void> {
    const videoReader = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack }).readable.getReader()
    active.readers.push(videoReader)
    const audioReader = audioTrack ? new MediaStreamTrackProcessor<AudioData>({ track: audioTrack }).readable.getReader() : null
    if (audioReader) active.readers.push(audioReader)

    let canvas: OffscreenCanvas | null = null
    let lastKeyframeUs = -Infinity
    let frames = 0
    // The last picture seen, to repeat while the screen stays still.
    const still: { frame: VideoFrame | null; timestampUs: number; at: number } = { frame: null, timestampUs: 0, at: 0 }

    const setUp = async (frame: VideoFrame): Promise<void> => {
      const width = frame.displayWidth - (frame.displayWidth % 2)
      const height = frame.displayHeight - (frame.displayHeight % 2)
      active.width = width
      active.height = height
      const config: VideoEncoderConfig = {
        codec: width * height * FPS > 983_040 * 256 ? 'avc1.640034' : 'avc1.640033',
        avc: { format: 'avc' },
        width,
        height,
        bitrate: videoBitrateFor(width, height),
        framerate: FPS,
        latencyMode: 'realtime'
      }
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
      if (!support?.supported) throw new WebRecorderError(appError('capture-failed', 'Este navegador não codifica H.264.'))
      const muxer = new Muxer<Target>({
        target: active.target as Target,
        video: { codec: 'avc', width, height, frameRate: FPS },
        ...(audioReader ? { audio: { codec: 'aac' as const, sampleRate: EXPORT_CONFIG.audioSampleRate, numberOfChannels: 2 } } : {}),
        fastStart: active.writable ? false : 'in-memory',
        firstTimestampBehavior: 'offset'
      })
      active.muxer = muxer
      // Live chunks carry no duration; the muxer gets the frame interval instead.
      const write = (track: 'video' | 'audio', chunk: EncodedVideoChunk | EncodedAudioChunk, meta: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata | undefined): void => {
        if (active.failure) return
        try {
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          const duration = chunk.duration ?? (track === 'video' ? Math.round(1_000_000 / FPS) : 0)
          if (track === 'video') muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, duration, meta as EncodedVideoChunkMetadata)
          else muxer.addAudioChunkRaw(data, chunk.type, chunk.timestamp, duration, meta as EncodedAudioChunkMetadata)
        } catch (error) {
          active.failure = error instanceof Error ? error : new Error(String(error))
        }
      }
      active.videoEncoder = new VideoEncoder({
        output: (chunk, meta) => write('video', chunk, meta),
        error: (error) => {
          active.failure = error
        }
      })
      active.videoEncoder.configure(config)
      if (audioReader) {
        const audioConfig: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: EXPORT_CONFIG.audioSampleRate, numberOfChannels: 2, bitrate: AUDIO_BITRATE }
        const audioSupport = await AudioEncoder.isConfigSupported(audioConfig).catch(() => null)
        if (audioSupport?.supported) {
          active.audioEncoder = new AudioEncoder({
            output: (chunk, meta) => write('audio', chunk, meta),
            error: (error) => {
              active.failure = error
            }
          })
          active.audioEncoder.configure(audioConfig)
        }
      }
    }

    const encodeVideo = (frame: VideoFrame): void => {
      const encoder = active.videoEncoder as VideoEncoder
      if (encoder.encodeQueueSize > MAX_QUEUED_FRAMES) {
        frame.close()
        return
      }
      let toEncode = frame
      if (frame.displayWidth !== active.width || frame.displayHeight !== active.height) {
        // The window changed size: fit the picture into the file's frame, letterboxed.
        canvas ??= new OffscreenCanvas(active.width, active.height)
        const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
        context.fillStyle = '#000'
        context.fillRect(0, 0, active.width, active.height)
        const scale = Math.min(active.width / frame.displayWidth, active.height / frame.displayHeight)
        const drawWidth = Math.round(frame.displayWidth * scale)
        const drawHeight = Math.round(frame.displayHeight * scale)
        context.drawImage(frame, Math.round((active.width - drawWidth) / 2), Math.round((active.height - drawHeight) / 2), drawWidth, drawHeight)
        toEncode = new VideoFrame(canvas, { timestamp: frame.timestamp })
        frame.close()
      }
      const keyFrame = toEncode.timestamp - lastKeyframeUs >= KEYFRAME_INTERVAL_US
      if (keyFrame) lastKeyframeUs = toEncode.timestamp
      encoder.encode(toEncode, { keyFrame })
      toEncode.close()
      frames++
    }

    const readVideo = async (): Promise<void> => {
      for (;;) {
        const { value: frame, done } = await videoReader.read()
        if (done || !frame) return
        if (active.stopping || active.failure) {
          frame.close()
          return
        }
        try {
          if (!active.muxer) await setUp(frame)
          still.frame?.close()
          still.frame = frame.clone()
          still.timestampUs = frame.timestamp
          still.at = performance.now()
          encodeVideo(frame)
        } catch (error) {
          frame.close()
          active.failure = error instanceof Error ? error : new Error(String(error))
          return
        }
      }
    }

    const readAudio = async (): Promise<void> => {
      if (!audioReader) return
      for (;;) {
        const { value: data, done } = await audioReader.read()
        if (done || !data) return
        // Audio before the first frame has nowhere to go yet; the tracks line up by their own first timestamps.
        if (active.audioEncoder && !active.stopping && !active.failure && active.audioEncoder.encodeQueueSize < 64) active.audioEncoder.encode(data)
        data.close()
      }
    }

    const heartbeat = setInterval(() => {
      const idle = performance.now() - still.at
      if (!still.frame || active.stopping || active.failure || idle < STILL_FRAME_INTERVAL_MS) return
      still.timestampUs += Math.round(idle * 1000)
      still.at = performance.now()
      try {
        encodeVideo(new VideoFrame(still.frame, { timestamp: still.timestampUs }))
      } catch (error) {
        active.failure = error instanceof Error ? error : new Error(String(error))
      }
    }, STILL_FRAME_INTERVAL_MS / 2)

    await Promise.all([readVideo(), readAudio()])
    clearInterval(heartbeat)
    still.frame?.close()
    if (frames === 0) active.failure ??= new Error('no frames were captured')
    this.settle?.()
  }

  /** Ends the recording and returns the file; throws `WebRecorderError` when nothing usable was recorded. */
  async stop(): Promise<WebRecording> {
    const active = this.active
    if (!active) throw new WebRecorderError(appError('invalid-state'))
    active.stopping = true
    // Stopping the tracks ends the readers; the pump then settles.
    active.display.getTracks().forEach((track) => track.stop())
    active.microphone?.getTracks().forEach((track) => track.stop())
    active.mixedTrack?.stop()
    for (const reader of active.readers) reader.cancel().catch(() => undefined)
    await this.finished
    const durationMs = Math.round(performance.now() - active.startedAt)

    try {
      if (active.failure) throw active.failure
      if (!active.muxer || !active.videoEncoder) throw new Error('no frames were captured')
      await active.videoEncoder.flush()
      await active.audioEncoder?.flush()
      active.muxer.finalize()
      await active.writable?.close()
      active.writable = null
    } catch (error) {
      this.release(active)
      throw new WebRecorderError(appError('recording-invalid', String(error)))
    }
    this.release(active)

    if (active.target instanceof ArrayBufferTarget) {
      return { file: new File([active.target.buffer], `${recordingTitle(new Date())}.mp4`, { type: 'video/mp4' }), handle: null, durationMs }
    }
    const file = await active.handle?.getFile().catch(() => null)
    if (!file) throw new WebRecorderError(appError('recording-invalid', 'the saved file could not be read back'))
    return { file, handle: active.handle, durationMs }
  }

  private release(active: Active): void {
    active.display.getTracks().forEach((track) => track.stop())
    active.microphone?.getTracks().forEach((track) => track.stop())
    active.mixedTrack?.stop()
    void active.audioContext?.close().catch(() => undefined)
    try {
      active.videoEncoder?.close()
    } catch {
      // Already closed.
    }
    try {
      active.audioEncoder?.close()
    } catch {
      // Already closed.
    }
    void active.writable?.abort().catch(() => undefined)
    if (this.active === active) {
      this.active = null
      this.finished = null
      this.settle = null
    }
  }
}

/** "Gravação de Tela 2026-11-17 às 15.04.09", as the desktop app names its recordings. */
export function recordingTitle(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `Gravação de Tela ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} às ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
}

export const webRecorder = new WebRecorder()
