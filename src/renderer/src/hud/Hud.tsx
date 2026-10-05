import { useEffect, useRef } from 'react'
import { formatClock } from '@shared/format'
import { currentElapsedMs, useRecordingState } from '../common/recordingStore'
import {
  CameraIcon,
  CameraOffIcon,
  ChevronDownIcon,
  CloseIcon,
  DisplayIcon,
  GripIcon,
  MicIcon,
  MicOffIcon,
  MinimizeIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  WindowIcon
} from './icons'

const TIMER_REFRESH_MS = 200

/**
 * The always-on-top recording bar. It stays on screen for the whole
 * recording, yet never shows up in the video: the capture excludes it.
 *
 * Before recording: source, microphone, the computer's sound, camera and the record button.
 * While recording: the timer, what is being recorded, pause/resume and stop.
 */
export function Hud() {
  const state = useRecordingState()
  const { recording, hud, recorder } = window.screenrx
  const { microphoneName, systemAudio, cameraName } = state.options

  if (state.phase === 'idle' || state.phase === 'starting') {
    const starting = state.phase === 'starting'
    const source = state.selectedSource
    return (
      <div className="hud" data-error={state.lastError !== null}>
        <Grip />
        <button
          className="hud-source"
          disabled={starting}
          title={state.lastError?.message ?? 'Escolher o que gravar'}
          onClick={() => void hud.showSourceMenu()}
        >
          {source?.kind === 'window' ? <WindowIcon /> : <DisplayIcon />}
          <span className="hud-source-label">{source?.label ?? 'Escolher fonte'}</span>
          <ChevronDownIcon />
        </button>

        <Divider />
        <button
          className="hud-icon"
          data-active={microphoneName !== null}
          disabled={starting}
          aria-label="Microfone"
          title={`Microfone: ${microphoneName ?? 'desligado'}`}
          onClick={() => void hud.showMicrophoneMenu()}
        >
          {microphoneName !== null ? <MicIcon /> : <MicOffIcon />}
        </button>
        <button
          className="hud-icon"
          data-active={systemAudio}
          disabled={starting}
          role="switch"
          aria-checked={systemAudio}
          aria-label="Som do computador"
          title={`Som do computador: ${systemAudio ? 'será gravado' : 'não será gravado'}`}
          onClick={() => void recording.setSystemAudio(!systemAudio)}
        >
          {systemAudio ? <SpeakerIcon /> : <SpeakerOffIcon />}
        </button>
        <button
          className="hud-icon"
          data-active={cameraName !== null}
          disabled={starting}
          aria-label="Câmera"
          title={`Câmera: ${cameraName ?? 'desligada'}`}
          onClick={() => void hud.showCameraMenu()}
        >
          {cameraName !== null ? <CameraIcon /> : <CameraOffIcon />}
        </button>
        <Divider />

        <button
          className="hud-record"
          disabled={starting}
          aria-label="Gravar"
          title={starting ? 'Iniciando…' : 'Gravar'}
          onClick={() => {
            // Without a source the library window explains what is missing.
            if (source) void recording.start()
            else void recorder.close()
          }}
        >
          <span className="hud-record-dot" data-busy={starting} />
        </button>

        <Divider />
        <button className="hud-icon" aria-label="Mais opções" title="Mais opções" onClick={() => void hud.showOptionsMenu()}>
          <MoreIcon />
        </button>
        <button className="hud-icon" aria-label="Minimizar" title="Minimizar" onClick={() => void hud.minimize()}>
          <MinimizeIcon />
        </button>
        <button
          className="hud-icon"
          aria-label="Fechar"
          title="Fechar e voltar às gravações"
          onClick={() => void recorder.close()}
        >
          <CloseIcon />
        </button>
      </div>
    )
  }

  const paused = state.phase === 'paused'
  const stopping = state.phase === 'stopping'
  return (
    <div className="hud" data-phase={state.phase}>
      <Grip />
      <span className="hud-status" data-paused={paused}>
        {paused ? <PauseIcon /> : <span className="hud-live-dot" />}
        <ElapsedTime />
      </span>
      <span className="hud-spacer" />
      <span className="hud-tracks" aria-label="Trilhas em gravação">
        {microphoneName !== null && <MicIcon />}
        {systemAudio && <SpeakerIcon />}
        {cameraName !== null && <CameraIcon />}
      </span>
      {paused ? (
        <button className="hud-icon" title="Retomar" aria-label="Retomar" disabled={stopping} onClick={() => void recording.resume()}>
          <PlayIcon />
        </button>
      ) : (
        <button className="hud-icon" title="Pausar" aria-label="Pausar" disabled={stopping} onClick={() => void recording.pause()}>
          <PauseIcon />
        </button>
      )}
      <button className="hud-record" title="Finalizar" aria-label="Finalizar" disabled={stopping} onClick={() => void recording.stop()}>
        <span className="hud-stop-square" />
      </button>
    </div>
  )
}

/** The bar is dragged by its background; the grip just makes that discoverable. */
function Grip() {
  return (
    <span className="hud-grip" aria-hidden="true">
      <GripIcon />
    </span>
  )
}

function Divider() {
  return <span className="hud-divider" aria-hidden="true" />
}

/** Writes the timer straight to the DOM, so ticking never re-renders React. */
function ElapsedTime() {
  const state = useRecordingState()
  const element = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const render = (): void => {
      if (element.current) element.current.textContent = formatClock(currentElapsedMs())
    }
    render()
    if (!state.clockRunning) return
    const timer = setInterval(render, TIMER_REFRESH_MS)
    return () => clearInterval(timer)
  }, [state])

  return <span ref={element} className="hud-timer" />
}
