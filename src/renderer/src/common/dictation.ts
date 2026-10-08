import { useCallback, useEffect, useRef, useState } from 'react'
import { DICTATION_MAX_SECONDS, DICTATION_RATE, encodeWav } from '@shared/dictation'

export type DictationPhase = 'idle' | 'recording' | 'transcribing'

export interface Dictation {
  phase: DictationPhase
  /** Seconds recorded so far, while recording. */
  seconds: number
  error: string | null
  /** One click starts recording; the next ends it and transcribes. */
  toggle: () => void
  /** Throws the recording away. */
  cancel: () => void
}

/** What was recorded (webm/opus) as 16 kHz mono WAV, which is what the transcriber reads. */
async function toWav(blob: Blob): Promise<Uint8Array> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * DICTATION_RATE)), DICTATION_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return encodeWav((await offline.startRendering()).getChannelData(0), DICTATION_RATE)
  } finally {
    context.close().catch(() => undefined)
  }
}

/**
 * Dictating into a text field: records the microphone and gives back the
 * words, transcribed on this Mac; the audio is then discarded. The text goes
 * through `onText`, so the user reads it before sending.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const discard = useRef(false)
  const deliver = useRef(onText)
  useEffect(() => {
    deliver.current = onText
  }, [onText])

  const release = useCallback((): void => {
    if (timer.current !== null) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    recorder.current = null
  }, [])

  const stop = useCallback((): void => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  const finish = useCallback(async (): Promise<void> => {
    const blob = new Blob(chunks.current, { type: recorder.current?.mimeType || 'audio/webm' })
    chunks.current = []
    release()
    if (discard.current || blob.size === 0) {
      setPhase('idle')
      return
    }
    setPhase('transcribing')
    try {
      const result = await window.screenrx.dictation.transcribe(await toWav(blob))
      if (result.ok) {
        if (result.value.text) deliver.current(result.value.text)
      } else {
        setError(result.error.message)
      }
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure))
    } finally {
      setPhase('idle')
    }
  }, [release])

  const start = useCallback(async (): Promise<void> => {
    setError(null)
    discard.current = false
    try {
      if (!(await window.screenrx.dictation.requestMicrophone())) {
        throw new Error('Sem acesso ao microfone. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone.')
      }
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      const instance = new MediaRecorder(stream.current)
      recorder.current = instance
      chunks.current = []
      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data)
      }
      instance.onstop = () => void finish()
      instance.start()
      setSeconds(0)
      setPhase('recording')
      let elapsed = 0
      timer.current = setInterval(() => {
        elapsed += 1
        setSeconds(elapsed)
        if (elapsed >= DICTATION_MAX_SECONDS) stop()
      }, 1000)
    } catch (failure) {
      release()
      setPhase('idle')
      setError(String((failure as Error)?.message ?? failure))
    }
  }, [finish, release, stop])

  const toggle = useCallback((): void => {
    if (phase === 'idle') void start()
    else if (phase === 'recording') stop()
  }, [phase, start, stop])

  const cancel = useCallback((): void => {
    if (phase !== 'recording') return
    discard.current = true
    stop()
  }, [phase, stop])

  // Leaving the screen throws away a recording in progress.
  useEffect(
    () => () => {
      discard.current = true
      stop()
      release()
    },
    [release, stop]
  )

  return { phase, seconds, error, toggle, cancel }
}
