import type { DragEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { RECORDING_DRAG_TYPE } from './RecordingCard'
import { CloseIcon } from './icons'

interface Props {
  /** The heading over the row. */
  title: string
  /** How many are in it, shown next to the heading. */
  count: number
  /** Called with a recording dragged onto the row; without it the row takes no drops. */
  onDropRecording?: (sessionId: string) => void
  /** For a row with nothing in it: forgets the series. */
  onRemove?: () => void
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
export function Shelf({ title, count, onDropRecording, onRemove, children }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [reach, setReach] = useState({ before: false, after: false })
  const [dropping, setDropping] = useState(false)

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
        {title}
        <span className="shelf-chevron" aria-hidden="true">
          ›
        </span>
        {count > 1 && <span className="shelf-count">{count}</span>}
        {count === 0 && onRemove && (
          <button className="shelf-remove" aria-label={`Remover a série ${title}`} title="Remover esta série vazia" onClick={onRemove}>
            <CloseIcon />
          </button>
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
