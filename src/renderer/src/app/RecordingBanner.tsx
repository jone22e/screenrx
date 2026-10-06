import { useEffect, useRef } from 'react'
import { formatClock } from '@shared/format'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import { currentElapsedMs } from '../common/recordingStore'

interface Props {
  state: RecordingStateSnapshot
}

/**
 * Shown on the library while a recording runs there (a meeting's, which has no recording bar): what is
 * being recorded, for how long, and pause/finish.
 */
export function RecordingBanner({ state }: Props) {
  if (state.phase === 'idle') return null
  const paused = state.phase === 'paused'
  const busy = state.phase === 'starting' || state.phase === 'stopping'
  return (
    <div className="recording-banner" role="status" data-phase={state.phase}>
      <span className="recording-banner-dot" data-paused={paused} aria-hidden="true" />
      <span className="recording-banner-text">
        <strong>{state.phase === 'starting' ? 'Iniciando a gravação…' : state.phase === 'stopping' ? 'Finalizando…' : paused ? 'Gravação pausada' : 'Gravando'}</strong>
        {state.selectedSource && <span className="recording-banner-source">{state.selectedSource.label}</span>}
      </span>
      <Elapsed running={state.clockRunning} />
      {paused ? (
        <button className="button" disabled={busy} onClick={() => void window.screenrx.recording.resume()}>
          Retomar
        </button>
      ) : (
        <button className="button" disabled={busy || state.phase !== 'recording'} onClick={() => void window.screenrx.recording.pause()}>
          Pausar
        </button>
      )}
      <button className="button button-primary" disabled={busy} onClick={() => void window.screenrx.recording.stop()}>
        Finalizar
      </button>
    </div>
  )
}

/** Writes the timer straight to the DOM, so ticking never re-renders React. */
function Elapsed({ running }: { running: boolean }) {
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const render = (): void => {
      if (element.current) element.current.textContent = formatClock(currentElapsedMs())
    }
    render()
    if (!running) return
    const timer = window.setInterval(render, 200)
    return () => window.clearInterval(timer)
  }, [running])
  return <span ref={element} className="recording-banner-time" />
}
