import type { DragEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { AppError } from '@shared/models/errors'
import type { RecordingStateSnapshot } from '@shared/models/recording'
import type { RecordingProgress, RecordingSummary } from '@shared/models/session'
import { MeetRooms } from './MeetRooms'
import { PermissionNotice } from './PermissionNotice'
import { RecordingBanner } from './RecordingBanner'
import { RecordingCard, SERIES_LIST_ID } from './RecordingCard'
import { SeriesDialog } from './SeriesDialog'
import { RecordingRow } from './RecordingRow'
import { Shelf } from './Shelf'
import { UpdateNotice } from './UpdateNotice'
import { VoiceModelNotice } from './VoiceModelNotice'
import { usePermissions } from './hooks'
import { openSettings } from '../common/settingsScreen'
import { CloseIcon, FilmIcon, GearIcon, GridIcon, HomeIcon, ImportIcon, JoinIcon, ListIcon, PlusIcon, SearchIcon } from './icons'
import { SESSION_SERIES_MAX_LENGTH } from '@shared/models/session'

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

type SortOrder = 'series' | 'newest' | 'oldest' | 'name' | 'longest' | 'largest'
const SORT_LABELS: Record<SortOrder, string> = {
  series: 'Por série',
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

/** The shelf for recordings in no series, after every series. */
const NO_SERIES_LABEL = 'Sem série'

/**
 * One group per series, the series with the newest recording first and, in
 * each, its recordings in the order made (a series is watched in order);
 * then the series made but still empty; the recordings in no series come
 * last, newest first.
 */
function groupBySeries(recordings: RecordingSummary[], made: readonly string[]): Array<{ label: string; items: RecordingSummary[] }> {
  const bySeries = new Map<string, RecordingSummary[]>()
  const loose: RecordingSummary[] = []
  for (const recording of [...recordings].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (recording.series === null) loose.push(recording)
    else bySeries.set(recording.series, [...(bySeries.get(recording.series) ?? []), recording])
  }
  const groups = [...bySeries].map(([label, items]) => ({ label, items: [...items].reverse() }))
  for (const name of made) if (!bySeries.has(name)) groups.push({ label: name, items: [] })
  if (loose.length > 0) groups.push({ label: NO_SERIES_LABEL, items: loose })
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
  const [order, setOrder] = useState<SortOrder>('series')
  const [filter, setFilter] = useState<Filter>('all')
  // The series the user made, empty ones included; the main process is the source.
  const [madeSeries, setMadeSeries] = useState<string[]>([])
  useEffect(() => {
    const load = (): void => void window.screenrx.library.series().then(setMadeSeries)
    load()
    return window.screenrx.library.onChanged(load)
  }, [])
  // "Nova série": a name typed in place; `null` while the field is closed.
  const [newSeries, setNewSeries] = useState<string | null>(null)
  const addSeries = (): void => {
    const name = (newSeries ?? '').trim()
    setNewSeries(null)
    if (name) void window.screenrx.library.addSeries(name)
  }
  // "Gerar série" for one recording.
  const [seriesFrom, setSeriesFrom] = useState<string | null>(null)
  const moveToSeries = (sessionId: string, series: string | null): void => {
    void window.screenrx.library.setSeries(sessionId, series ?? '')
  }
  const searchField = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLElement>(null)
  // The search field opens beside the rail's magnifier; closing it clears the search.
  const [searching, setSearching] = useState(false)
  const closeSearch = (): void => {
    setSearching(false)
    setQuery('')
  }
  const goHome = (): void => {
    closeSearch()
    setFilter('all')
    content.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }
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
        setSearching(true)
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

  // Joining recordings: the user picks two or more, in order; a new recording is made from them.
  const [joining, setJoining] = useState<{ open: boolean; picked: string[]; busy: boolean; error: AppError | null }>({ open: false, picked: [], busy: false, error: null })
  const togglePicked = (id: string): void =>
    setJoining((current) => ({ ...current, picked: current.picked.includes(id) ? current.picked.filter((entry) => entry !== id) : [...current.picked, id] }))
  const join = (): void => {
    setJoining((current) => ({ ...current, busy: true, error: null }))
    void window.screenrx.library.join(joining.picked).then((result) => {
      if (result.ok) {
        setJoining({ open: false, picked: [], busy: false, error: null })
        onEdit(result.value.sessionId)
      } else {
        setJoining((current) => ({ ...current, busy: false, error: result.error }))
      }
    })
  }

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
              (recording.series?.toLocaleLowerCase().includes(needle) ?? false) ||
              recording.sourceLabel.toLocaleLowerCase().includes(needle) ||
              (recording.transcriptPreview?.toLocaleLowerCase().includes(needle) ?? false) ||
              (transcriptHits.query === needle && transcriptHits.ids.has(recording.id))
          )
    return sorted(matching, order)
  }, [recordings, needle, filter, order, transcriptHits])

  const total = recordings?.length ?? 0
  const totalBytes = (recordings ?? []).reduce((sum, recording) => sum + recording.sizeBytes, 0)
  const totalMs = (recordings ?? []).reduce((sum, recording) => sum + recording.durationMs, 0)
  const grouped = order === 'series' || order === 'newest' || order === 'oldest'
  const groups = (items: RecordingSummary[]): Array<{ label: string; items: RecordingSummary[] }> =>
    order === 'series' ? groupBySeries(items, needle === '' && filter === 'all' ? madeSeries : []) : groupByDay(items)
  // Every series there is, for the field that puts a recording in one.
  const seriesNames = useMemo(
    () => [...new Set([...madeSeries, ...(recordings ?? []).flatMap((recording) => (recording.series ? [recording.series] : []))])].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [recordings, madeSeries]
  )

  const renderCards = (items: RecordingSummary[]) =>
    items.map((recording) => (
      <RecordingCard key={recording.id} recording={recording} highlighted={recording.id === state.lastCompletedSessionId} showSeries={order !== 'series'} onEdit={onEdit} onMakeSeries={setSeriesFrom} />
    ))

  const renderItems = (items: RecordingSummary[]) =>
    view === 'grid' ? (
      <div className="card-grid">{renderCards(items)}</div>
    ) : (
      <div className="row-list">
        {items.map((recording) => (
          <RecordingRow key={recording.id} recording={recording} highlighted={recording.id === state.lastCompletedSessionId} showSeries={order !== 'series'} onEdit={onEdit} onMakeSeries={setSeriesFrom} />
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
        <span className="home-bar-space" />
        <button
          className="bar-icon bar-icon-boxed"
          aria-label="Juntar gravações"
          title="Juntar duas ou mais gravações em uma só, uma depois da outra"
          disabled={!canImport || (recordings?.filter((recording) => recording.status === 'completed').length ?? 0) < 2}
          onClick={() => setJoining({ open: true, picked: [], busy: false, error: null })}
        >
          <JoinIcon />
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

      {/* The rail on the left, as a streaming service has it: home, search, settings. */}
      <nav className="home-rail" aria-label="Biblioteca">
        <button className="home-rail-button" data-active={!searching && filter === 'all'} aria-label="Início" title="Início" onClick={goHome}>
          <HomeIcon />
        </button>
        <button
          className="home-rail-button"
          data-active={searching}
          aria-label="Buscar"
          title="Buscar em títulos, séries e transcrições (⌘K)"
          onClick={() => (searching ? closeSearch() : setSearching(true))}
        >
          <SearchIcon />
        </button>
        <button className="home-rail-button" aria-label="Configurações" title="Configurações" onClick={openSettings}>
          <GearIcon />
        </button>
      </nav>
      <main className="home-content" ref={content}>
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

        {seriesFrom && (recordings ?? []).some((recording) => recording.id === seriesFrom) && (
          <SeriesDialog recording={(recordings ?? []).find((recording) => recording.id === seriesFrom) as RecordingSummary} onClose={() => setSeriesFrom(null)} />
        )}

        {joining.open && (
          <div className="dialog-backdrop" role="presentation">
            <div className="dialog" role="dialog" aria-modal="true" aria-label="Juntar gravações">
              <h2 className="dialog-title">Juntar gravações</h2>
              <p className="panel-hint">
                Marque as gravações na ordem em que devem ficar. Sai uma gravação nova, com o vídeo, o som e o rastro do mouse
                emendados; as originais continuam na biblioteca. Vídeos de tamanhos diferentes são encaixados no tamanho da primeira.
              </p>
              <ul className="join-list">
                {(recordings ?? [])
                  .filter((recording) => recording.status === 'completed')
                  .map((recording) => {
                    const position = joining.picked.indexOf(recording.id)
                    return (
                      <li key={recording.id}>
                        <label className="check join-row">
                          <input type="checkbox" checked={position >= 0} disabled={joining.busy} onChange={() => togglePicked(recording.id)} />
                          <span className="join-order">{position >= 0 ? position + 1 : ''}</span>
                          <span className="join-title">{recording.title}</span>
                          <span className="join-meta">{formatClock(recording.durationMs)}</span>
                        </label>
                      </li>
                    )
                  })}
              </ul>
              {joining.error && (
                <p className="dialog-error" role="alert">
                  {joining.error.message}
                </p>
              )}
              {joining.busy && <p className="panel-hint">Juntando… O vídeo é recodificado inteiro, o que leva alguns minutos para gravações longas.</p>}
              <div className="dialog-actions">
                <button className="panel-button" disabled={joining.busy} onClick={() => setJoining({ open: false, picked: [], busy: false, error: null })}>
                  Cancelar
                </button>
                <button className="panel-button panel-button-primary" disabled={joining.busy || joining.picked.length < 2} onClick={join}>
                  Juntar {joining.picked.length >= 2 ? `${joining.picked.length} gravações` : ''}
                </button>
              </div>
            </div>
          </div>
        )}

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
                {order === 'series' &&
                  (newSeries === null ? (
                    <button className="bar-icon bar-icon-boxed series-add" title="Nova série" onClick={() => setNewSeries('')}>
                      <PlusIcon /> Nova série
                    </button>
                  ) : (
                    <input
                      className="series-input series-new"
                      type="text"
                      value={newSeries}
                      maxLength={SESSION_SERIES_MAX_LENGTH}
                      autoFocus
                      spellCheck={false}
                      aria-label="Nome da nova série"
                      placeholder="Nome da série"
                      onChange={(event) => setNewSeries(event.target.value)}
                      onBlur={addSeries}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          addSeries()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setNewSeries(null)
                        }
                      }}
                    />
                  ))}
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

            {searching && (
              <label className="home-search">
                <SearchIcon />
                <input
                  ref={searchField}
                  type="search"
                  placeholder="Buscar em títulos, séries e transcrições"
                  value={query}
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      closeSearch()
                    }
                  }}
                />
                <button className="home-search-close" aria-label="Fechar a busca" title="Fechar a busca (Esc)" onClick={closeSearch}>
                  <CloseIcon />
                </button>
              </label>
            )}

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

            <datalist id={SERIES_LIST_ID}>
              {seriesNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>

            {/* By series or by date, the cards go on one shelf per group, side by side, as a streaming service lays them out. */}
            {grouped
              ? groups(visible).map((group) =>
                  view === 'grid' ? (
                    <Shelf
                      key={group.label}
                      title={group.label}
                      count={group.items.length}
                      {...(order === 'series' && {
                        onDropRecording: (sessionId: string) => moveToSeries(sessionId, group.label === NO_SERIES_LABEL ? null : group.label),
                        ...(group.label !== NO_SERIES_LABEL && { onRemove: () => void window.screenrx.library.removeSeries(group.label) })
                      })}
                    >
                      {renderCards(group.items)}
                    </Shelf>
                  ) : (
                    <section key={group.label} className="day">
                      <h2 className="day-label">{group.label}</h2>
                      {renderItems(group.items)}
                    </section>
                  )
                )
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
