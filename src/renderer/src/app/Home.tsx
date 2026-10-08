import type { DragEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { AppError } from '@shared/models/errors'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import type { RecordingProgress, RecordingSummary } from '@shared/models/session'
import { MeetRooms } from './MeetRooms'
import { PermissionNotice } from './PermissionNotice'
import { RecordingBanner } from './RecordingBanner'
import { RecordingCard } from './RecordingCard'
import { RecordingRow } from './RecordingRow'
import { UpdateNotice } from './UpdateNotice'
import { VoiceModelNotice } from './VoiceModelNotice'
import { usePermissions } from './hooks'
import { openSettings } from '../common/settingsScreen'
import { FilmIcon, GearIcon, GridIcon, ImportIcon, ListIcon, SearchIcon } from './icons'

interface Props {
  state: RecordingStateSnapshot
  recordings: RecordingSummary[] | null
  onEdit: (sessionId: string) => void
}

const dayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
const dayWithYearFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })

/** How the library lays its recordings out; remembered between launches. */
type LibraryView = 'grid' | 'list'
const VIEW_KEY = 'screenrx.library.view'

type SortOrder = 'newest' | 'oldest' | 'name' | 'longest' | 'largest'
const SORT_LABELS: Record<SortOrder, string> = {
  newest: 'Mais recentes',
  oldest: 'Mais antigas',
  name: 'Nome',
  longest: 'Mais longas',
  largest: 'Maiores'
}

type Filter = 'all' | RecordingProgress
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'edited', label: 'Em edição' },
  { id: 'captioned', label: 'Com legendas' },
  { id: 'exported', label: 'Exportadas' },
  { id: 'imported', label: 'Importadas' }
]

/** Typing stops for this long before the transcripts are searched. */
const SEARCH_DEBOUNCE_MS = 250

function readStoredView(): LibraryView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

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

function sorted(recordings: RecordingSummary[], order: SortOrder): RecordingSummary[] {
  const copy = [...recordings]
  switch (order) {
    case 'oldest':
      return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    case 'name':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))
    case 'longest':
      return copy.sort((a, b) => b.durationMs - a.durationMs)
    case 'largest':
      return copy.sort((a, b) => b.sizeBytes - a.sizeBytes)
    default:
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

const hasVideoFile = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files')

/**
 * The library: every recording, newest first. "Nova gravação" hides this
 * window and brings up the recording bar, where what to record is chosen;
 * when the recording ends, the app comes back here with it open in the editor.
 */
export function Home({ state, recordings, onEdit }: Props) {
  const permissions = usePermissions()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<LibraryView>(readStoredView)
  const [order, setOrder] = useState<SortOrder>('newest')
  const [filter, setFilter] = useState<Filter>('all')
  const searchField = useRef<HTMLInputElement>(null)
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view)
    } catch {
      // Not remembering the layout is no reason to fail.
    }
  }, [view])
  const granted = permissions.report?.permissions.screenRecording === 'granted'
  const idle = state.phase === 'idle'

  // ⌘K goes to the search; ⌘⇧R starts a recording.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchField.current?.focus()
        searchField.current?.select()
      } else if (event.shiftKey && event.key.toLowerCase() === 'r' && idle) {
        event.preventDefault()
        void window.screenrx.recorder.open()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [idle])

  // Importing a video recorded elsewhere: a file dialog, or files dropped on the window.
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<AppError | null>(null)
  const [dropping, setDropping] = useState(false)
  const finishImport = (result: { ok: true; value: { sessionIds: string[] } } | { ok: false; error: AppError }): void => {
    if (!result.ok) setImportError(result.error)
    // One file opens straight in the editor, like a recording that has just finished.
    else if (result.value.sessionIds.length === 1) onEdit(result.value.sessionIds[0] as string)
  }
  const importVideo = (): void => {
    setImporting(true)
    setImportError(null)
    void window.screenrx.library.import().then(finishImport).finally(() => setImporting(false))
  }
  const importDropped = (files: File[]): void => {
    if (files.length === 0 || !idle || importing) return
    setImporting(true)
    setImportError(null)
    void window.screenrx.library.importFiles(files).then(finishImport).finally(() => setImporting(false))
  }
  const canImport = idle && !importing

  // The search looks at titles here and asks the main process which transcripts contain the words.
  const needle = query.trim().toLocaleLowerCase()
  const [transcriptHits, setTranscriptHits] = useState<{ query: string; ids: ReadonlySet<string> }>({ query: '', ids: new Set() })
  useEffect(() => {
    if (needle === '') return
    const timer = window.setTimeout(() => {
      void window.screenrx.library.search(needle).then((ids) => setTranscriptHits({ query: needle, ids: new Set(ids) }))
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [needle])

  const visible = useMemo(() => {
    const all = recordings ?? []
    const filtered = filter === 'all' ? all : all.filter((recording) => recording.progress === filter)
    const matching =
      needle === ''
        ? filtered
        : filtered.filter(
            (recording) =>
              recording.title.toLocaleLowerCase().includes(needle) ||
              recording.sourceLabel.toLocaleLowerCase().includes(needle) ||
              (recording.transcriptPreview?.toLocaleLowerCase().includes(needle) ?? false) ||
              (transcriptHits.query === needle && transcriptHits.ids.has(recording.id))
          )
    return sorted(matching, order)
  }, [recordings, needle, filter, order, transcriptHits])

  const total = recordings?.length ?? 0
  const totalBytes = (recordings ?? []).reduce((sum, recording) => sum + recording.sizeBytes, 0)
  const totalMs = (recordings ?? []).reduce((sum, recording) => sum + recording.durationMs, 0)
  const grouped = order === 'newest' || order === 'oldest'

  const renderItems = (items: RecordingSummary[]) =>
    view === 'grid' ? (
      <div className="card-grid">
        {items.map((recording) => (
          <RecordingCard key={recording.id} recording={recording} highlighted={recording.id === state.lastCompletedSessionId} onEdit={onEdit} />
        ))}
      </div>
    ) : (
      <div className="row-list">
        {items.map((recording) => (
          <RecordingRow key={recording.id} recording={recording} highlighted={recording.id === state.lastCompletedSessionId} onEdit={onEdit} />
        ))}
      </div>
    )

  return (
    <div
      className="home"
      data-dropping={dropping}
      onDragOver={(event) => {
        if (!hasVideoFile(event)) return
        event.preventDefault()
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDropping(false)
        importDropped(Array.from(event.dataTransfer.files))
      }}
    >
      <header className="home-bar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          ScreenRx
        </span>
        <label className="search">
          <SearchIcon />
          <input
            ref={searchField}
            type="search"
            placeholder="Buscar em títulos e transcrições"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd className="search-shortcut">⌘K</kbd>
        </label>
        <button className="bar-icon" aria-label="Configurações" title="Configurações" onClick={openSettings}>
          <GearIcon />
        </button>
        <button
          className="bar-icon bar-icon-boxed"
          aria-label="Importar vídeo"
          title={importing ? 'Importando…' : 'Importar um vídeo gravado fora do ScreenRx'}
          disabled={!canImport}
          onClick={importVideo}
        >
          <ImportIcon />
        </button>
        <button className="new-recording" disabled={!idle} title="Nova gravação (⌘⇧R)" onClick={() => void window.screenrx.recorder.open()}>
          <span className="new-recording-dot" aria-hidden="true" />
          Nova gravação
          <kbd className="new-recording-shortcut">⌘⇧R</kbd>
        </button>
      </header>

      <main className="home-content">
        <RecordingBanner state={state} />
        <UpdateNotice idle={idle} />
        <VoiceModelNotice />
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
        {importing && (
          <div className="notice" role="status">
            <p>Importando vídeo… Um arquivo que não está em H.264 é convertido, o que pode levar alguns minutos.</p>
          </div>
        )}
        {importError && (
          <div className="notice notice-error" role="alert">
            <p>{importError.message}</p>
            <button className="button" onClick={() => setImportError(null)}>
              Fechar
            </button>
          </div>
        )}
        {permissions.report && !granted && (
          <PermissionNotice report={permissions.report} onRequest={permissions.request} />
        )}

        <MeetRooms idle={idle} />

        {recordings !== null && total === 0 && (
          <div className="empty-state">
            <span className="empty-art">
              <FilmIcon size={34} />
            </span>
            <h1>Nenhuma gravação ainda</h1>
            <p>
              Clique em Nova gravação para abrir a barra de gravação e escolher o que gravar. Quando terminar,
              a gravação abre no editor e aparece aqui. Um vídeo gravado em outro app também pode ser
              importado, ou arrastado para esta janela.
            </p>
            <div className="empty-actions">
              <button className="new-recording" disabled={!idle} onClick={() => void window.screenrx.recorder.open()}>
                <span className="new-recording-dot" aria-hidden="true" />
                Nova gravação
              </button>
              <button className="import-video" disabled={!canImport} onClick={importVideo}>
                <ImportIcon />
                {importing ? 'Importando…' : 'Importar vídeo'}
              </button>
            </div>
          </div>
        )}

        {total > 0 && (
          <>
            <div className="library-header">
              <h1>
                Gravações <span className="library-count">{total}</span>
              </h1>
              <div className="library-tools">
                {view === 'list' && (
                  <div className="filter-chips" role="radiogroup" aria-label="Filtro">
                    {FILTERS.map((option) => (
                      <button key={option.id} className="chip" role="radio" aria-checked={filter === option.id} onClick={() => setFilter(option.id)}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                <label className="sort-select">
                  <select aria-label="Ordem" value={order} onChange={(event) => setOrder(event.target.value as SortOrder)}>
                    {(Object.keys(SORT_LABELS) as SortOrder[]).map((option) => (
                      <option key={option} value={option}>
                        {SORT_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="view-switch" role="group" aria-label="Visualização">
                  <button className="view-option" aria-pressed={view === 'grid'} aria-label="Ver em grade" title="Grade" onClick={() => setView('grid')}>
                    <GridIcon />
                  </button>
                  <button className="view-option" aria-pressed={view === 'list'} aria-label="Ver em lista" title="Lista" onClick={() => setView('list')}>
                    <ListIcon />
                  </button>
                </div>
              </div>
            </div>

            {view === 'list' && visible.length > 0 && (
              <div className="row-head" aria-hidden="true">
                <span />
                <span>Nome</span>
                <span>Status</span>
                <span className="row-figure">Duração</span>
                <span className="row-figure">Tamanho</span>
                <span />
              </div>
            )}

            {visible.length === 0 && (
              <p className="muted">
                {needle ? `Nenhuma gravação encontrada para “${query.trim()}”.` : 'Nenhuma gravação neste filtro.'}
              </p>
            )}

            {grouped
              ? groupByDay(visible).map((group) => (
                  <section key={group.label} className="day">
                    <h2 className="day-label">{group.label}</h2>
                    {renderItems(group.items)}
                  </section>
                ))
              : renderItems(visible)}
          </>
        )}
      </main>

      {total > 0 && (
        <footer className="home-footer">
          <span>
            {total === 1 ? '1 gravação' : `${total} gravações`} · {formatClock(totalMs)} no total
            {view === 'list' && ' · Arraste um vídeo para importar'}
          </span>
          <span>{formatBytes(totalBytes)} usados</span>
        </footer>
      )}

      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <ImportIcon /> Solte para importar o vídeo
        </div>
      )}
    </div>
  )
}
