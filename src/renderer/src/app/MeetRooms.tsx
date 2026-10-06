import { useCallback, useEffect, useState } from 'react'
import type { AppError } from '@shared/models/errors'
import type { MeetRoom } from '@shared/models/meet'
import { useMeetConfigured, meetSettings } from '../common/meetSettings'

interface Props {
  /** Recording is only offered while nothing else is being recorded. */
  idle: boolean
}

const REFRESH_MS = 10_000

/**
 * The meetings happening right now on the meeting app (Screen Live), each
 * with a button to record it. Only shown once the app is configured in the
 * settings. Rooms exist while someone is in them, so the list is refreshed
 * regularly and whenever the window regains focus.
 */
export function MeetRooms({ idle }: Props) {
  const configured = useMeetConfigured()
  const [rooms, setRooms] = useState<MeetRoom[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [failure, setFailure] = useState<AppError | null>(null)

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

  return (
    <section className="meet" aria-label="Reuniões">
      <div className="library-header">
        <h1>Reuniões ao vivo</h1>
        <span className="library-summary">
          {rooms === null ? 'Consultando o Screen Live…' : rooms.length === 0 ? 'Nenhuma reunião em andamento' : rooms.length === 1 ? '1 reunião' : `${rooms.length} reuniões`}
        </span>
        <button className="button" onClick={refresh}>
          Atualizar
        </button>
      </div>

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

      {rooms !== null && rooms.length > 0 && (
        <div className="row-list">
          {rooms.map((room) => (
            <div key={room.code} className="meet-room" data-recording={room.recording}>
              <span className="meet-room-name">
                <strong>{room.name}</strong>
                <span className="meet-room-code">{room.code}</span>
              </span>
              <span className="meet-room-people">
                {room.participantCount === 1 ? '1 pessoa' : `${room.participantCount} pessoas`}
              </span>
              {room.recording ? (
                <span className="meet-room-badge">Gravando</span>
              ) : (
                <button
                  className="button button-primary"
                  disabled={!idle || starting !== null}
                  onClick={() => void record(room.code)}
                >
                  {starting === room.code ? 'Entrando…' : 'Gravar'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
