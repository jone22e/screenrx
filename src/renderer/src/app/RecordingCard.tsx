import { useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { RecordingSummary } from '@shared/models/session'
import { RecordingTitle } from './RecordingTitle'
import {
  CameraIcon,
  EditIcon,
  FilmIcon,
  FolderIcon,
  MicIcon,
  RenameIcon,
  SpeakerIcon,
  TrashIcon
} from './icons'

interface Props {
  recording: RecordingSummary
  /** The one just recorded gets a highlight. */
  highlighted: boolean
  onEdit: (sessionId: string) => void
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const STATUS_LABELS = { recording: 'Gravando', failed: 'Falhou' } as const

/** The small labels shown next to a recording's name when something is off. */
export function RecordingBadges({ recording }: { recording: RecordingSummary }) {
  return (
    <>
      {recording.status !== 'completed' && <span className="badge">{STATUS_LABELS[recording.status]}</span>}
      {recording.hasWarnings && <span className="badge badge-warning">Avisos</span>}
    </>
  )
}

/** Show in Finder, rename and delete — the same on a card and on a list row. */
export function RecordingActions({
  recording,
  onRename
}: {
  recording: RecordingSummary
  onRename: () => void
}) {
  const { library } = window.screenrx
  return (
    <>
      {recording.status === 'completed' && (
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

/** One recording in the library: its poster frame, what it contains, and what can be done with it. */
export function RecordingCard({ recording, highlighted, onEdit }: Props) {
  const [renaming, setRenaming] = useState(false)
  const editable = recording.status === 'completed'
  const details = [
    timeFormat.format(new Date(recording.createdAt)),
    formatBytes(recording.sizeBytes),
    recording.resolution && `${recording.resolution.widthPx}×${recording.resolution.heightPx}`
  ].filter(Boolean)

  return (
    <article className="card" data-highlight={highlighted} data-status={recording.status} data-renaming={renaming}>
      <button
        className="card-poster"
        disabled={!editable}
        aria-label={`Editar ${recording.title}`}
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
          <span className="card-title" title={renaming ? undefined : recording.title}>
            <RecordingTitle recording={recording} editing={renaming} onDone={() => setRenaming(false)} />
            {!renaming && <RecordingBadges recording={recording} />}
          </span>
          <span className="card-meta">{details.join(' · ')}</span>
        </div>
        <div className="card-actions">
          <RecordingActions recording={recording} onRename={() => setRenaming(true)} />
        </div>
      </div>
    </article>
  )
}
