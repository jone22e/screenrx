import { encodeWav16 } from '@engine/audio/wav'
import { captionLocaleOfLanguage } from '@engine/captions/whisperWords'
import type { Unsubscribe } from '@shared/ipc/contract'
import type { LocaleDetection, Transcript, TranscriptTrack, TranscriptionProgress, TranscriptionRequest } from '@shared/models/captions'
import { TRANSCRIPT_SCHEMA_VERSION } from '@shared/models/captions'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { PlatformServices } from '@shared/models/platform'
import type { TranscriptionEvent } from '@shared/models/transcriptionApi'
import { TRANSCRIPTION_API_PATH, TRANSCRIPTION_SAMPLE_RATE, parseTranscriptionEvent, parseTranscriptionServiceInfo } from '@shared/models/transcriptionApi'
import { webSessions } from './sessions'
import { webStorage } from './storage'

export class WebTranscriptionError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'WebTranscriptionError'
  }
}

/** How long the page waits for the server to say what it offers before going on without it. */
const PROBE_TIMEOUT_MS = 4000

/** Asks the server which services it offers; none when it does not answer (e.g. the page served alone). */
export async function probeServices(): Promise<PlatformServices> {
  try {
    const response = await fetch(TRANSCRIPTION_API_PATH, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
    if (!response.ok) return { transcription: false }
    const info = parseTranscriptionServiceInfo(await response.json())
    return { transcription: info?.transcription ?? false }
  } catch {
    return { transcription: false }
  }
}

interface Run {
  sessionId: string
  controller: AbortController
}

/**
 * Speech-to-text for the web editor: the video's sound is decoded in the
 * page, sent to the server as a small mono WAV, and the words come back as
 * they are transcribed. The transcript is kept in the browser with the
 * project. One at a time, as on the desktop.
 */
export class WebTranscriber {
  private running: Run | null = null
  private readonly listeners = new Set<(progress: TranscriptionProgress) => void>()

  onProgress(listener: (progress: TranscriptionProgress) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async generate(sessionId: string, request: TranscriptionRequest): Promise<Transcript> {
    const result = await this.send(sessionId, request.track, `?locale=${encodeURIComponent(request.locale)}`)
    const transcript: Transcript = { schemaVersion: TRANSCRIPT_SCHEMA_VERSION, locale: request.locale, track: request.track, words: result.words }
    await webStorage.writeTranscript(sessionId, transcript).catch(() => undefined)
    return transcript
  }

  async detectLocale(sessionId: string, track: TranscriptTrack): Promise<LocaleDetection> {
    const result = await this.send(sessionId, track, '?mode=detect')
    const locale = result.language ? captionLocaleOfLanguage(result.language) : null
    return locale ? { locale, candidates: [{ locale, installed: true, confidence: 1, words: result.words.length }] } : { locale: null, candidates: [] }
  }

  cancel(): void {
    this.running?.controller.abort()
  }

  private emit(sessionId: string, stage: TranscriptionProgress['stage'], fraction: number): void {
    for (const listener of this.listeners) listener({ sessionId, stage, fraction })
  }

  private async send(sessionId: string, track: TranscriptTrack, query: string): Promise<Extract<TranscriptionEvent, { type: 'done' }>> {
    if (this.running) throw new WebTranscriptionError(appError('transcription-busy'))
    const video = webSessions.require(sessionId)
    if (track !== 'microphone' || !video.hasAudio) throw new WebTranscriptionError(appError('transcription-failed', `session has no ${track} track`))
    const run: Run = { sessionId, controller: new AbortController() }
    this.running = run
    try {
      this.emit(sessionId, 'preparing', 0)
      const wav = await speechWav(video.file, run.controller.signal)
      this.emit(sessionId, 'transcribing', 0)
      let response: Response
      try {
        response = await fetch(`${TRANSCRIPTION_API_PATH}${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
          signal: run.controller.signal
        })
      } catch (error) {
        if (run.controller.signal.aborted) throw new WebTranscriptionError(appError('transcription-cancelled'))
        throw new WebTranscriptionError(appError('transcription-server-unreachable', String(error)))
      }
      if (response.status === 413) throw new WebTranscriptionError(appError('transcription-too-long'))
      if (response.status === 404) throw new WebTranscriptionError(appError('transcription-unavailable', 'the server offers no transcription'))
      if (!response.ok || !response.body) throw new WebTranscriptionError(appError('transcription-failed', `server answered ${response.status}`))
      let done: Extract<TranscriptionEvent, { type: 'done' }> | null = null
      for await (const event of jsonLines(response.body)) {
        if (event.type === 'progress') this.emit(sessionId, event.stage ?? 'transcribing', event.fraction)
        else if (event.type === 'done') done = event
        else throw new WebTranscriptionError(event.detail === undefined ? appError(event.code) : appError(event.code, event.detail))
      }
      if (!done) throw new WebTranscriptionError(appError('transcription-failed', 'the server ended without the words'))
      return done
    } catch (error) {
      if (run.controller.signal.aborted) throw new WebTranscriptionError(appError('transcription-cancelled'))
      if (error instanceof WebTranscriptionError) throw error
      throw new WebTranscriptionError(appError('transcription-failed', String(error)))
    } finally {
      if (this.running === run) this.running = null
    }
  }
}

/** The file's sound as mono 16-bit WAV at the rate the recognizer listens at. */
async function speechWav(file: Blob, signal: AbortSignal): Promise<Uint8Array> {
  const context = new OfflineAudioContext(1, 1, TRANSCRIPTION_SAMPLE_RATE)
  let buffer: AudioBuffer
  try {
    buffer = await context.decodeAudioData(await file.arrayBuffer())
  } catch (error) {
    throw new WebTranscriptionError(appError('transcription-failed', `the browser cannot decode the sound: ${String(error)}`))
  }
  if (signal.aborted) throw new WebTranscriptionError(appError('transcription-cancelled'))
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel)
    for (let index = 0; index < mono.length; index++) mono[index] = (mono[index] ?? 0) + (samples[index] ?? 0) / buffer.numberOfChannels
  }
  return encodeWav16(mono, buffer.sampleRate)
}

/** The events of a JSON-lines answer, as they arrive. */
async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<TranscriptionEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const parse = (line: string): TranscriptionEvent | null => {
    if (line.trim() === '') return null
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new WebTranscriptionError(appError('transcription-failed', 'the server sent an unreadable line'))
    }
    const event = parseTranscriptionEvent(value)
    if (!event) throw new WebTranscriptionError(appError('transcription-failed', 'the server sent an unexpected line'))
    return event
  }
  for (;;) {
    const { value, done } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split('\n')
    pending = done ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      const event = parse(line)
      if (event) yield event
    }
    if (done) return
  }
}
