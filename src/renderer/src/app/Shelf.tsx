import type { DragEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { SESSION_SERIES_MAX_LENGTH } from '@shared/models/session'
import { RECORDING_DRAG_TYPE } from './RecordingCard'
import { CloseIcon, RenameIcon } from './icons'

interface Props {
  /** The heading over the row. */
  title: string
  /** How many are in it, shown next to the heading. */
  count: number
  /** Called with a recording dragged onto the row; without it the row takes no drops. */
  onDropRecording?: (sessionId: string) => void
  /** Removes the series (its recordings stay, in no series). */
  onRemove?: () => void
  /** Gives the series a new name. */
  onRename?: (name: string) => void
  children: ReactNode
}


const carriesRecording = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes(RECORDING_DRAG_TYPE)

const ChevronIcon = ({ direction }: { direction: 'left' | 'right' }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {direction === 'left' ? <path d="M15 5l-7 7 7 7" /> : <path d="M9 5l7 7-7 7" />}
  </svg>
)

/**
 * One row of the library as a streaming service lays it out: a heading, the
 * items side by side, and a page's worth of them scrolled at a time with the
 * arrows at the edges, which only show where there is more to see.
 */
export function Shelf({ title, count, onDropRecording, onRemove, onRename, children }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [reach, setReach] = useState({ before: false, after: false })
  const [dropping, setDropping] = useState(false)
  // The title being edited (`null` while it is not), and whether the × is waiting for a yes.
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const finishRename = (save: boolean): void => {
    const name = (draft ?? '').trim()
    setDraft(null)
    if (save && onRename && name && name !== title) onRename(name)
  }

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = (): void => {
      const before = element.scrollLeft > 4
      const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 4
      setReach((current) => (current.before === before && current.after === after ? current : { before, after }))
    }
    // Fires once on observe, so the first measurement needs no call of its own.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [])

  const page = (direction: -1 | 1): void => {
    const element = scroller.current
    if (!element) return
    // A page is the visible width less one card's worth, so the last one seen is the first one next.
    const step = Math.max(element.clientWidth * 0.85, 200)
    element.scrollBy({ left: direction * step, behavior: 'smooth' })
  }

  return (
    <section
      className="shelf"
      data-before={reach.before}
      data-after={reach.after}
      data-dropping={dropping}
      data-empty={count === 0}
      onDragOver={(event) => {
        if (!onDropRecording || !carriesRecording(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={(event) => {
        if (!onDropRecording || !carriesRecording(event)) return
        event.preventDefault()
        setDropping(false)
        const sessionId = event.dataTransfer.getData(RECORDING_DRAG_TYPE)
        if (sessionId) onDropRecording(sessionId)
      }}
    >
      <h2 className="shelf-title">
        {draft === null ? (
          title
        ) : (
          <input
            className="series-input shelf-rename"
            type="text"
            value={draft}
            maxLength={SESSION_SERIES_MAX_LENGTH}
            autoFocus
            spellCheck={false}
            aria-label="Novo nome da série"
            onFocus={(event) => event.target.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finishRename(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                finishRename(true)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                finishRename(false)
              }
            }}
          />
        )}
        <span className="shelf-chevron" aria-hidden="true">
          ›
        </span>
        {count > 1 && <span className="shelf-count">{count}</span>}
        {draft === null && onRename && (
          <button className="shelf-tool" aria-label={`Renomear a série ${title}`} title="Renomear a série" onClick={() => setDraft(title)}>
            <RenameIcon />
          </button>
        )}
        {draft === null && onRemove && !confirming && (
          <button className="shelf-tool" aria-label={`Remover a série ${title}`} title={count === 0 ? 'Remover esta série vazia' : 'Remover a série; as gravações ficam, sem série'} onClick={() => (count === 0 ? onRemove() : setConfirming(true))}>
            <CloseIcon />
          </button>
        )}
        {confirming && (
          <span className="shelf-confirm">
            {count === 1 ? 'Tirar 1 gravação da série?' : `Tirar ${count} gravações da série?`}
            <button className="panel-button panel-button-small" onClick={() => setConfirming(false)}>
              Não
            </button>
            <button
              className="panel-button panel-button-small panel-button-danger"
              onClick={() => {
                setConfirming(false)
                onRemove?.()
              }}
            >
              Remover
            </button>
          </span>
        )}
      </h2>
      {count === 0 && <p className="shelf-empty">Arraste gravações para cá, ou use "Série" no cartão de uma gravação.</p>}
      <div className="shelf-body">
        <button className="shelf-arrow shelf-arrow-before" aria-label="Anteriores" title="Anteriores" tabIndex={reach.before ? 0 : -1} onClick={() => page(-1)}>
          <ChevronIcon direction="left" />
        </button>
        <div className="shelf-scroller" ref={scroller}>
          {children}
        </div>
        <button className="shelf-arrow shelf-arrow-after" aria-label="Próximas" title="Próximas" tabIndex={reach.after ? 0 : -1} onClick={() => page(1)}>
          <ChevronIcon direction="right" />
        </button>
      </div>
    </section>
  )
}
