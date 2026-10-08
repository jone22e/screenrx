import { useState } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import type { RecordingSummary } from '@shared/models/session'
import { ProgressBadge, RecordingActions, RecordingBadges, SuggestedTitle } from './RecordingCard'
import { RecordingTitle } from './RecordingTitle'
import { FilmIcon } from './icons'

interface Props {
  recording: RecordingSummary
  highlighted: boolean
  onEdit: (sessionId: string) => void
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' })

/** "Hoje, 07:49" / "Ontem, 16:20" / "3 de out., 10:05". */
function when(createdAt: string): string {
  const date = new Date(createdAt)
  const now = new Date()
  const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  const day = days === 0 ? 'Hoje' : days === 1 ? 'Ontem' : dayFormat.format(date)
  return `${day}, ${timeFormat.format(date)}`
}

/** One recording as a row of the list view: a small poster, the name, how far it has come, and the figures. */
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
      <span className="row-name">
        <span className="row-title" title={renaming ? undefined : recording.title}>
          <RecordingTitle recording={recording} editing={renaming} onDone={() => setRenaming(false)} />
          {!renaming && <RecordingBadges recording={recording} />}
        </span>
        {!renaming && <SuggestedTitle recording={recording} />}
        <span className="row-when">{when(recording.createdAt)}</span>
      </span>
      <span className="row-cell row-status">
        <ProgressBadge recording={recording} />
      </span>
      <span className="row-cell row-figure">{formatClock(recording.durationMs)}</span>
      <span className="row-cell row-figure">{formatBytes(recording.sizeBytes)}</span>
      <span className="row-actions">
        <RecordingActions recording={recording} onRename={() => setRenaming(true)} />
      </span>
    </div>
  )
}
