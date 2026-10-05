import { useMemo, useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import type { RecordingSummary } from '@shared/models/session'
import { PermissionNotice } from './PermissionNotice'
import { RecordingCard } from './RecordingCard'
import { usePermissions } from './hooks'
import { openSettings } from '../common/settingsScreen'
import { FilmIcon, GearIcon, SearchIcon } from './icons'

interface Props {
  state: RecordingStateSnapshot
  recordings: RecordingSummary[] | null
  onEdit: (sessionId: string) => void
}

const dayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
const dayWithYearFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
const DAY_MS = 24 * 60 * 60 * 1000

/** "Hoje", "Ontem", or the date — the heading recordings are grouped under. */
function dayLabel(date: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
  if (days === 0) return 'Hoje'
  if (days === 1) return 'Ontem'
  const label = (date.getFullYear() === now.getFullYear() ? dayFormat : dayWithYearFormat).format(date)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function groupByDay(recordings: RecordingSummary[]): Array<{ label: string; items: RecordingSummary[] }> {
  const now = new Date()
  const groups: Array<{ label: string; items: RecordingSummary[] }> = []
  for (const recording of recordings) {
    const label = dayLabel(new Date(recording.createdAt), now)
    const group = groups.at(-1)
    if (group?.label === label) group.items.push(recording)
    else groups.push({ label, items: [recording] })
  }
  return groups
}

/**
 * The library: every recording, newest first. "Nova gravação" hides this
 * window and brings up the recording bar, where what to record is chosen;
 * when the recording ends, the app comes back here with it open in the editor.
 */
export function Home({ state, recordings, onEdit }: Props) {
  const permissions = usePermissions()
  const [query, setQuery] = useState('')
  const granted = permissions.report?.permissions.screenRecording === 'granted'

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const all = recordings ?? []
    return needle ? all.filter((recording) => recording.sourceLabel.toLocaleLowerCase().includes(needle)) : all
  }, [recordings, query])

  const total = recordings?.length ?? 0
  const totalBytes = (recordings ?? []).reduce((sum, recording) => sum + recording.sizeBytes, 0)
  const totalMs = (recordings ?? []).reduce((sum, recording) => sum + recording.durationMs, 0)

  return (
    <div className="home">
      <header className="home-bar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          ScreenRx
        </span>
        <label className="search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Buscar gravações"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="bar-icon" aria-label="Configurações" title="Configurações" onClick={openSettings}>
          <GearIcon />
        </button>
        <button className="new-recording" onClick={() => void window.screenrx.recorder.open()}>
          <span className="new-recording-dot" aria-hidden="true" />
          Nova gravação
        </button>
      </header>

      <main className="home-content">
        {state.lastError && (
          <div className="notice notice-error" role="alert">
            <p>{state.lastError.message}</p>
            <button className="button" onClick={() => void window.screenrx.recording.dismissError()}>
              Fechar
            </button>
          </div>
        )}
        {permissions.error && (
          <div className="notice notice-error" role="alert">
            <p>{permissions.error.message}</p>
          </div>
        )}
        {permissions.report && !granted && (
          <PermissionNotice report={permissions.report} onRequest={permissions.request} />
        )}

        {recordings !== null && total === 0 && (
          <div className="empty-state">
            <span className="empty-art">
              <FilmIcon size={34} />
            </span>
            <h1>Nenhuma gravação ainda</h1>
            <p>
              Clique em Nova gravação para abrir a barra de gravação e escolher o que gravar. Quando terminar,
              a gravação abre no editor e aparece aqui.
            </p>
            <button className="new-recording" onClick={() => void window.screenrx.recorder.open()}>
              <span className="new-recording-dot" aria-hidden="true" />
              Nova gravação
            </button>
          </div>
        )}

        {total > 0 && (
          <>
            <div className="library-header">
              <h1>Gravações</h1>
              <span className="library-summary">
                {total === 1 ? '1 gravação' : `${total} gravações`} · {formatClock(totalMs)} ·{' '}
                {formatBytes(totalBytes)}
              </span>
            </div>

            {visible.length === 0 && <p className="muted">Nenhuma gravação encontrada para “{query.trim()}”.</p>}

            {groupByDay(visible).map((group) => (
              <section key={group.label} className="day">
                <h2 className="day-label">{group.label}</h2>
                <div className="card-grid">
                  {group.items.map((recording) => (
                    <RecordingCard
                      key={recording.id}
                      recording={recording}
                      highlighted={recording.id === state.lastCompletedSessionId}
                      onEdit={onEdit}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </main>
    </div>
  )
}
