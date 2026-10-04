import { formatBytes, formatClock } from '@shared/format'
import type { RecordingSummary } from '@shared/models/session'
import { CameraIcon, EditIcon, FilmIcon, FolderIcon, MicIcon, SpeakerIcon, TrashIcon } from './icons'

interface Props {
  recording: RecordingSummary
  /** The one just recorded gets a highlight. */
  highlighted: boolean
  onEdit: (sessionId: string) => void
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const STATUS_LABELS = { recording: 'Gravando', failed: 'Falhou' } as const

/** One recording in the library: its poster frame, what it contains, and what can be done with it. */
export function RecordingCard({ recording, highlighted, onEdit }: Props) {
  const { library } = window.screenrx
  const editable = recording.status === 'completed'
  const details = [
    timeFormat.format(new Date(recording.createdAt)),
    formatBytes(recording.sizeBytes),
    recording.resolution && `${recording.resolution.widthPx}×${recording.resolution.heightPx}`
  ].filter(Boolean)

  return (
    <article className="card" data-highlight={highlighted} data-status={recording.status}>
      <button
        className="card-poster"
        disabled={!editable}
        aria-label={`Editar ${recording.sourceLabel}`}
        onClick={() => onEdit(recording.id)}
      >
        {recording.thumbnailUrl ? (
          <img src={recording.thumbnailUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="card-poster-empty">
            <FilmIcon />
          </span>
        )}
        {editable && (
          <span className="card-open">
            <EditIcon /> Editar
          </span>
        )}
        <span className="card-tracks">
          {recording.hasWebcam && <CameraIcon />}
          {recording.hasMicrophone && <MicIcon />}
          {recording.hasSystemAudio && <SpeakerIcon />}
        </span>
        <span className="card-duration">{formatClock(recording.durationMs)}</span>
      </button>

      <div className="card-info">
        <div className="card-text">
          <span className="card-title">
            {recording.sourceLabel}
            {recording.status !== 'completed' && (
              <span className="badge">{STATUS_LABELS[recording.status]}</span>
            )}
            {recording.hasWarnings && <span className="badge badge-warning">Avisos</span>}
          </span>
          <span className="card-meta">{details.join(' · ')}</span>
        </div>
        <div className="card-actions">
          {editable && (
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
            <button
              className="icon-button icon-button-danger"
              aria-label="Excluir gravação"
              title="Mover para a Lixeira"
              onClick={() => void library.delete(recording.id)}
            >
              <TrashIcon />
            </button>
          )}
        </div>
      </div>
    </article>
  )
}
