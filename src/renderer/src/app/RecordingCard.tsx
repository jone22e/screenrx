import { useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { RecordingProgress, RecordingSummary } from '@shared/models/session'
import { RecordingTitle } from './RecordingTitle'
import {
  CameraIcon,
  EditIcon,
  FilmIcon,
  FolderIcon,
  MicIcon,
  RenameIcon,
  SpeakerIcon,
  SparklesIcon,
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

/** One recording in the library: its poster frame, how far it has come, and what can be done with it. */
export function RecordingCard({ recording, highlighted, onEdit }: Props) {
  const [renaming, setRenaming] = useState(false)
  const editable = recording.status === 'completed'

  return (
    <article className="card" data-highlight={highlighted} data-status={recording.status} data-renaming={renaming}>
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
          <RecordingActions recording={recording} onRename={() => setRenaming(true)} />
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
        {!renaming && <SuggestedTitle recording={recording} />}
        <span className="card-meta">
          {timeFormat.format(new Date(recording.createdAt))} · {formatBytes(recording.sizeBytes)}
        </span>
      </div>
    </article>
  )
}
