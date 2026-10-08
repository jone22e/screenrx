import { useCallback, useEffect, useState } from 'react'
import type { AppError } from '@shared/models/errors'
import type { MeetRoom } from '@shared/models/meet'
import { useMeetConfigured, meetSettings } from '../common/meetSettings'
import { CameraIcon } from './icons'

interface Props {
  /** Recording is only offered while nothing else is being recorded. */
  idle: boolean
}

const REFRESH_MS = 10_000

/** "começou há 12 min" */
function since(createdAt: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60_000))
  if (minutes < 1) return 'começou agora'
  if (minutes < 60) return `começou há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `começou há ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/**
 * The meetings happening right now on the meeting app (Screen Live), each as
 * a banner with a button to record it. Only shown once the app is configured
 * in the settings, and only while there is a meeting. Rooms exist while
 * someone is in them, so the list is refreshed regularly and whenever the
 * window regains focus. A banner can be put away until the meeting ends.
 */
export function MeetRooms({ idle }: Props) {
  const configured = useMeetConfigured()
  const [rooms, setRooms] = useState<MeetRoom[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [failure, setFailure] = useState<AppError | null>(null)
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    void meetSettings.load()
  }, [])

  const refresh = useCallback(() => {
    if (!configured) return
    void window.screenrx.meet.listRooms().then((result) => {
      if (result.ok) {
        setRooms(result.value)
        setError(null)
      } else {
        setError(result.error)
      }
    })
  }, [configured])

  useEffect(() => {
    if (!configured) return
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [configured, refresh])

  if (!configured) return null

  const record = async (code: string): Promise<void> => {
    setStarting(code)
    setFailure(null)
    const result = await window.screenrx.meet.record(code)
    setStarting(null)
    if (!result.ok) setFailure(result.error)
  }

  const shown = (rooms ?? []).filter((room) => !ignored.has(room.code))
  if (!error && !failure && shown.length === 0) return null

  return (
    <section className="meet" aria-label="Reuniões ao vivo">
      {error && (
        <p className="meet-error" role="alert">
          {error.message}
        </p>
      )}
      {failure && (
        <p className="meet-error" role="alert">
          {failure.message}
        </p>
      )}
      {shown.map((room) => (
        <div key={room.code} className="meet-banner" data-recording={room.recording}>
          <span className="meet-banner-icon" aria-hidden="true">
            <CameraIcon />
          </span>
          <span className="meet-banner-text">
            <strong>{room.name} está ao vivo</strong>
            <span>
              Screen Live · {since(room.createdAt)} · {room.participantCount === 1 ? '1 participante' : `${room.participantCount} participantes`}
              {room.recording && ' · já está sendo gravada'}
            </span>
          </span>
          <button className="meet-ignore" onClick={() => setIgnored((current) => new Set(current).add(room.code))}>
            Ignorar
          </button>
          {!room.recording && (
            <button className="new-recording" disabled={!idle || starting !== null} onClick={() => void record(room.code)}>
              <span className="new-recording-dot" aria-hidden="true" />
              {starting === room.code ? 'Entrando…' : 'Gravar reunião'}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
