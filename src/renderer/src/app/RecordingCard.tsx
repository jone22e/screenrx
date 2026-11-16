import { useRef, useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import { SESSION_SERIES_MAX_LENGTH } from '@shared/models/session'
import type { RecordingProgress, RecordingSummary } from '@shared/models/session'
import { RecordingTitle } from './RecordingTitle'
import {
  CameraIcon,
  CoverIcon,
  CoverOffIcon,
  EditIcon,
  FilmIcon,
  FolderIcon,
  MicIcon,
  RenameIcon,
  SeriesIcon,
  SpeakerIcon,
  SparklesIcon,
  TrashIcon
} from './icons'

interface Props {
  recording: RecordingSummary
  /** The one just recorded gets a highlight. */
  highlighted: boolean
  /** Whether to name the series on the card: not when the shelf already is the series. */
  showSeries: boolean
  onEdit: (sessionId: string) => void
  /** Opens "Gerar série" for the recording. */
  onMakeSeries: (sessionId: string) => void
}

/** The drag data type a recording's card carries, read by the shelves. */
export const RECORDING_DRAG_TYPE = 'application/x-screenrx-recording'

/** The id of the list of series names the series field offers; rendered once, by the library. */
export const SERIES_LIST_ID = 'library-series-names'

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const STATUS_LABELS = { recording: 'Gravando', failed: 'Falhou' } as const

/** How far a recording has come, in words; `null` for one nothing was done to yet. */
export const PROGRESS_LABELS: Record<RecordingProgress, string | null> = {
  new: null,
  imported: 'Importado',
  edited: 'Em edição',
  captioned: 'Legendas prontas',
  exported: 'Exportado'
}

/** The small labels shown next to a recording's name when something is off. */
export function RecordingBadges({ recording }: { recording: RecordingSummary }) {
  return (
    <>
      {recording.status !== 'completed' && <span className="badge">{STATUS_LABELS[recording.status]}</span>}
      {recording.hasWarnings && <span className="badge badge-warning">Avisos</span>}
    </>
  )
}

/** The dot and the word for how far a recording has come. */
export function ProgressBadge({ recording }: { recording: RecordingSummary }) {
  const label = PROGRESS_LABELS[recording.progress]
  if (!label || recording.status !== 'completed') return null
  return (
    <span className="progress-badge" data-progress={recording.progress}>
      <span className="progress-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

/** "Renomear para …": the name the transcript suggests, applied with one click. */
export function SuggestedTitle({ recording }: { recording: RecordingSummary }) {
  const [applying, setApplying] = useState(false)
  if (!recording.suggestedTitle || recording.status !== 'completed') return null
  const apply = (): void => {
    setApplying(true)
    void window.screenrx.library.rename(recording.id, recording.suggestedTitle ?? '').finally(() => setApplying(false))
  }
  return (
    <button className="suggested-title" disabled={applying} title="Nome sugerido a partir do que foi dito" onClick={apply}>
      <SparklesIcon /> Renomear para “{recording.suggestedTitle}”
    </button>
  )
}

/**
 * The field a recording's series is typed in, offering the series that exist.
 * Enter or leaving the field saves; Escape gives up; empty takes it out of any.
 */
export function SeriesEditor({ recording, onDone }: { recording: RecordingSummary; onDone: () => void }) {
  const [draft, setDraft] = useState(recording.series ?? '')
  const finished = useRef(false)
  const finish = (save: boolean): void => {
    if (finished.current) return
    finished.current = true
    if (save && draft.trim() !== (recording.series ?? '')) void window.screenrx.library.setSeries(recording.id, draft)
    onDone()
  }
  return (
    <input
      className="series-input"
      type="text"
      list={SERIES_LIST_ID}
      value={draft}
      maxLength={SESSION_SERIES_MAX_LENGTH}
      autoFocus
      spellCheck={false}
      aria-label="Série da gravação"
      placeholder="Série (vazio: nenhuma)"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      }}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

/** Show in Finder, rename, series, cover and delete — the same on a card and on a list row. */
export function RecordingActions({
  recording,
  onRename,
  onSeries,
  onMakeSeries
}: {
  recording: RecordingSummary
  onRename: () => void
  onSeries: () => void
  onMakeSeries: () => void
}) {
  const { library } = window.screenrx
  const done = recording.status === 'completed'
  return (
    <>
      {done && (
        <button
          className="icon-button"
          aria-label="Mostrar no Finder"
          title="Mostrar no Finder"
          onClick={() => void library.reveal(recording.id)}
        >
          <FolderIcon />
        </button>
      )}
      {recording.status !== 'recording' && (
        <button className="icon-button" aria-label="Renomear" title="Renomear" onClick={onRename}>
          <RenameIcon />
        </button>
      )}
      {done && (
        <button className="icon-button" aria-label="Série" title={recording.series ? `Série: ${recording.series}` : 'Pôr numa série'} onClick={onSeries}>
          <SeriesIcon />
        </button>
      )}
      {done && (
        <button
          className="icon-button"
          aria-label={recording.hasCover ? 'Trocar a capa' : 'Escolher uma capa'}
          title={recording.hasCover ? 'Trocar a capa por outra imagem' : 'Escolher uma imagem como capa'}
          onClick={() => void library.chooseCover(recording.id)}
        >
          <CoverIcon />
        </button>
      )}
      {done && recording.hasCover && (
        <button className="icon-button" aria-label="Remover a capa" title="Remover a capa e voltar ao quadro do vídeo" onClick={() => void library.clearCover(recording.id)}>
          <CoverOffIcon />
        </button>
      )}
      {done && (
        <button className="icon-button icon-button-ai" aria-label="Gerar série" title="Gerar série: a IA divide esta gravação em episódios" onClick={onMakeSeries}>
          <SparklesIcon />
        </button>
      )}
      {recording.status !== 'recording' && (
        <button
          className="icon-button icon-button-danger"
          aria-label="Excluir gravação"
          title="Mover para a Lixeira"
          onClick={() => void library.delete(recording.id)}
        >
          <TrashIcon />
        </button>
      )}
    </>
  )
}

/** One recording in the library: its poster frame, how far it has come, and what can be done with it. */
export function RecordingCard({ recording, highlighted, showSeries, onEdit, onMakeSeries }: Props) {
  const [renaming, setRenaming] = useState(false)
  const [editingSeries, setEditingSeries] = useState(false)
  const editable = recording.status === 'completed'

  return (
    <article
      className="card"
      data-highlight={highlighted}
      data-status={recording.status}
      data-renaming={renaming || editingSeries}
      // A card can be dragged onto a shelf to put the recording in that series.
      draggable={editable && !renaming && !editingSeries}
      onDragStart={(event) => {
        event.dataTransfer.setData(RECORDING_DRAG_TYPE, recording.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
    >
      <div className="card-poster">
        {recording.thumbnailUrl ? (
          <img src={recording.thumbnailUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="card-poster-empty">
            <FilmIcon />
          </span>
        )}
        <span className="card-badge">
          <ProgressBadge recording={recording} />
        </span>
        <span className="card-tracks">
          {recording.hasWebcam && <CameraIcon />}
          {recording.hasMicrophone && <MicIcon />}
          {recording.hasSystemAudio && <SpeakerIcon />}
        </span>
        <span className="card-duration">{formatClock(recording.durationMs)}</span>
        {/* The actions come up over the picture when the pointer is on the card. */}
        <span className="card-hover">
          {editable && (
            <button className="card-edit" onClick={() => onEdit(recording.id)}>
              <EditIcon /> Editar
            </button>
          )}
          {/* The tools on a row of their own under "Editar", wrapping when the card is narrow. */}
          <span className="card-hover-tools">
            <RecordingActions recording={recording} onRename={() => setRenaming(true)} onSeries={() => setEditingSeries(true)} onMakeSeries={() => onMakeSeries(recording.id)} />
          </span>
        </span>
        {editable && (
          <button className="card-open-area" aria-label={`Editar ${recording.title}`} onClick={() => onEdit(recording.id)} />
        )}
      </div>

      <div className="card-info">
        <span className="card-title" title={renaming ? undefined : recording.title}>
          <RecordingTitle recording={recording} editing={renaming} onDone={() => setRenaming(false)} />
          {!renaming && <RecordingBadges recording={recording} />}
        </span>
        {!renaming && !editingSeries && <SuggestedTitle recording={recording} />}
        {editingSeries ? (
          <SeriesEditor key={recording.id} recording={recording} onDone={() => setEditingSeries(false)} />
        ) : (
          <span className="card-meta">
            {showSeries && recording.series && <span className="card-series">{recording.series}</span>}
            {timeFormat.format(new Date(recording.createdAt))} · {formatBytes(recording.sizeBytes)}
          </span>
        )}
      </div>
    </article>
  )
}
