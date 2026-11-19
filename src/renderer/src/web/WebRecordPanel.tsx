import { useEffect, useRef, useState } from 'react'
import { formatClock } from '@shared/format'
import { VIDEO_KINDS, chooseSaveFile, downloadBlob } from './files'
import { WebRecorderError, canRecordInBrowser, recordingTitle, webRecorder } from './webRecorder'
import type { WebRecording } from './webRecorder'
import { MicIcon, SpeakerIcon } from '../editor/icons'

interface Props {
  /** Told when the recording is done; the caller opens it. */
  onRecorded: (recording: WebRecording) => Promise<void>
  disabled: boolean
}

/** How the browser's own messages read here. */
const MESSAGES: Partial<Record<string, string>> = {
  'microphone-permission-denied': 'O navegador não liberou o microfone. Permita-o para este site, ou grave sem ele.',
  'platform-unsupported': 'Este navegador não grava a tela. Use o Chrome ou o Edge.'
}

/**
 * Recording the screen from the page: the browser asks which screen, window
 * or tab, the file is written while it records, and the editor opens it when
 * it stops. Without a save dialog in the browser the file stays in memory
 * and is downloaded at the end.
 */
export function WebRecordPanel({ onRecorded, disabled }: Props) {
  const [microphone, setMicrophone] = useState(true)
  const [systemAudio, setSystemAudio] = useState(true)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'finishing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const stopping = useRef(false)

  useEffect(() => {
    if (phase !== 'recording') return
    const startedAt = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500)
    return () => clearInterval(timer)
  }, [phase])

  const stop = async (): Promise<void> => {
    if (stopping.current) return
    stopping.current = true
    setPhase('finishing')
    try {
      const recording = await webRecorder.stop()
      if (!recording.handle) downloadBlob(recording.file, recording.file.name)
      await onRecorded(recording)
    } catch (error) {
      setNotice(error instanceof WebRecorderError ? (MESSAGES[error.appError.code] ?? error.appError.message) : 'A gravação não pôde ser salva.')
    } finally {
      stopping.current = false
      setPhase('idle')
      setSeconds(0)
    }
  }

  // The browser's own "stop sharing" ends the capture: the file is finished the same way.
  useEffect(() => webRecorder.onEnded(() => void stop()), []) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (): Promise<void> => {
    setNotice(null)
    setPhase('starting')
    try {
      const handle = await chooseSaveFile(`${recordingTitle(new Date())}.mp4`, VIDEO_KINDS[0] as (typeof VIDEO_KINDS)[number], 'Vídeo MP4')
      if (handle === null) {
        setPhase('idle')
        return
      }
      await webRecorder.start({ microphone, systemAudio, handle: handle ?? null })
      setPhase('recording')
    } catch (error) {
      setPhase('idle')
      if (error instanceof WebRecorderError && error.appError.code === 'no-source-selected') return
      setNotice(error instanceof WebRecorderError ? (MESSAGES[error.appError.code] ?? error.appError.message) : 'Não foi possível começar a gravar.')
    }
  }

  if (!canRecordInBrowser()) return null

  return (
    <section className="web-record" aria-label="Gravar a tela" data-phase={phase}>
      <div className="web-record-row">
        <h2>Gravar a tela</h2>
        {phase === 'recording' || phase === 'finishing' ? (
          <span className="web-record-time" role="status">
            <span className="web-record-dot" aria-hidden="true" /> {phase === 'finishing' ? 'Salvando…' : formatClock(seconds * 1000)}
          </span>
        ) : (
          <div className="web-record-options">
            <label className="chip chip-small" title="Grava a sua voz pelo microfone">
              <input type="checkbox" checked={microphone} disabled={phase !== 'idle'} onChange={(event) => setMicrophone(event.target.checked)} />
              <MicIcon /> Microfone
            </label>
            <label className="chip chip-small" title="Grava o som da aba ou da tela, quando o navegador permite">
              <input type="checkbox" checked={systemAudio} disabled={phase !== 'idle'} onChange={(event) => setSystemAudio(event.target.checked)} />
              <SpeakerIcon /> Som do sistema
            </label>
          </div>
        )}
        {phase === 'recording' ? (
          <button className="panel-button panel-button-danger" onClick={() => void stop()}>
            Parar
          </button>
        ) : (
          <button className="panel-button" disabled={disabled || phase !== 'idle'} onClick={() => void start()}>
            {phase === 'starting' ? 'Escolhendo…' : phase === 'finishing' ? 'Salvando…' : 'Gravar…'}
          </button>
        )}
      </div>
      {notice && (
        <p className="panel-notice" role="alert">
          {notice}
        </p>
      )}
    </section>
  )
}
