import { useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { RecordingSummary } from '@shared/models/session'
import { RecordingActions, RecordingBadges } from './RecordingCard'
import { RecordingTitle } from './RecordingTitle'
import { CameraIcon, FilmIcon, MicIcon, SpeakerIcon } from './icons'

interface Props {
  recording: RecordingSummary
  highlighted: boolean
  onEdit: (sessionId: string) => void
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** One recording as a row of the list view: a small poster, the name and the figures in columns. */
export function RecordingRow({ recording, highlighted, onEdit }: Props) {
  const [renaming, setRenaming] = useState(false)
  const editable = recording.status === 'completed'

  return (
    <div
      className="row"
      data-highlight={highlighted}
      data-status={recording.status}
      data-renaming={renaming}
      onDoubleClick={() => editable && !renaming && onEdit(recording.id)}
    >
      <button
        className="row-poster"
        disabled={!editable}
        aria-label={`Editar ${recording.title}`}
        onClick={() => onEdit(recording.id)}
      >
        {recording.thumbnailUrl ? (
          <img src={recording.thumbnailUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="card-poster-empty">
            <FilmIcon size={16} />
          </span>
        )}
      </button>
      <span className="row-title" title={renaming ? undefined : recording.title}>
        <RecordingTitle recording={recording} editing={renaming} onDone={() => setRenaming(false)} />
        {!renaming && <RecordingBadges recording={recording} />}
      </span>
      <span className="row-tracks">
        {recording.hasWebcam && <CameraIcon />}
        {recording.hasMicrophone && <MicIcon />}
        {recording.hasSystemAudio && <SpeakerIcon />}
      </span>
      <span className="row-cell">{timeFormat.format(new Date(recording.createdAt))}</span>
      <span className="row-cell">{formatClock(recording.durationMs)}</span>
      <span className="row-cell">{formatBytes(recording.sizeBytes)}</span>
      <span className="row-cell">
        {recording.resolution ? `${recording.resolution.widthPx}×${recording.resolution.heightPx}` : '—'}
      </span>
      <span className="row-actions">
        <RecordingActions recording={recording} onRename={() => setRenaming(true)} />
      </span>
    </div>
  )
}
