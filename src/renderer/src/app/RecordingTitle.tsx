import { useRef, useState } from 'react'
import { SESSION_TITLE_MAX_LENGTH } from '@shared/models/session'
import type { RecordingSummary } from '@shared/models/session'

interface Props {
  recording: RecordingSummary
  /** Whether the name is being edited; the parent owns this so its button can start it. */
  editing: boolean
  onDone: () => void
}

/** A recording's name, which turns into a text field while it is being renamed. */
export function RecordingTitle({ recording, editing, onDone }: Props) {
  if (!editing) return <>{recording.title}</>
  return <TitleEditor key={recording.id} recording={recording} onDone={onDone} />
}

/**
 * The text field itself. Enter or leaving the field saves; Escape gives up.
 * An empty name is sent as well: it means "use the source's label again".
 */
function TitleEditor({ recording, onDone }: Omit<Props, 'editing'>) {
  const [draft, setDraft] = useState(recording.title)
  // Set once the edit has ended, so the blur that follows Enter or Escape does nothing.
  const finished = useRef(false)

  const finish = (save: boolean): void => {
    if (finished.current) return
    finished.current = true
    if (save && draft.trim() !== recording.title) void window.screenrx.library.rename(recording.id, draft)
    onDone()
  }

  return (
    <input
      className="title-input"
      type="text"
      value={draft}
      maxLength={SESSION_TITLE_MAX_LENGTH}
      autoFocus
      spellCheck={false}
      aria-label="Nome da gravação"
      placeholder={recording.sourceLabel}
      onFocus={(event) => event.target.select()}
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
