import type { PointerEvent, ReactNode } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sourceTimeToTimelineTime } from '@engine/time/timeMapping'
import { moveZoom, resizeZoom } from '@engine/zoom/zoomEditing'
import { formatClock, formatTimecode } from '@shared/format'
import type { EditorSession } from '@shared/models/editor'
import type { CaptionCue, TrimEffect, ZoomEffect } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import { Filmstrip } from './Filmstrip'
import type { PreviewPlayer } from './PreviewPlayer'
import { SUGGESTION_KIND_LABELS, previewSuggestion } from './SuggestionsPanel'
import { Waveform } from './Waveform'
import {
  CameraIcon,
  CaptionsIcon,
  CloseIcon,
  FilmIcon,
  MicIcon,
  ScissorsIcon,
  SpeakerIcon,
  ZoomIcon
} from './icons'

interface Props {
  session: EditorSession
  store: EditorStore
  player: PreviewPlayer
}

type DragKind = 'move' | 'start' | 'end'

/** A region being dragged, as it was when the drag began; every move is computed from it. */
type Drag = { kind: DragKind; originX: number } & (
  | { target: 'zoom'; original: ZoomEffect }
  | { target: 'trim'; original: TrimEffect }
  | { target: 'cue'; original: CaptionCue }
)

/** A press on the video lane: a click seeks, a drag selects. */
interface LanePress {
  originX: number
  timeMs: number
  selecting: boolean
}

const CLICK_TYPES = new Set(['click', 'doubleClick', 'rightClick'])

/** Candidate distances between ruler labels, in seconds. */
const RULER_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const MIN_LABEL_SPACING_PX = 72
/** Pointer travel that turns a click on the video lane into a selection. */
const SELECT_THRESHOLD_PX = 3

const AUDIO_LANES = {
  microphone: { label: 'Microfone', icon: <MicIcon /> },
  systemAudio: { label: 'Sistema', icon: <SpeakerIcon /> }
} as const

function rulerMarks(durationMs: number, widthPx: number): number[] {
  if (widthPx <= 0 || durationMs <= 0) return []
  const pxPerSecond = widthPx / (durationMs / 1000)
  const step = RULER_STEPS_S.find((seconds) => seconds * pxPerSecond >= MIN_LABEL_SPACING_PX) ?? 600
  const marks: number[] = []
  for (let seconds = 0; seconds * 1000 <= durationMs; seconds += step) marks.push(seconds * 1000)
  return marks
}

function LaneLabel({ icon, children, tall }: { icon: ReactNode; children: ReactNode; tall?: boolean }) {
  return (
    <span className="timeline-label" data-tall={tall === true}>
      {icon}
      {children}
    </span>
  )
}

/**
 * The timeline, laid out in the recording's own time: a ruler, the video as
 * a strip of thumbnails with its recorded clicks, the cuts, the zooms, the
 * captions, and one lane per companion track.
 *
 * Drag over the video to select a stretch (then cut it); click to move the
 * playhead; drag the ruler to scrub. Regions are dragged to move, by their
 * edges to resize; double-click the cut or zoom lane to add one there.
 */
export function Timeline({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const tracks = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const timecode = useRef<HTMLSpanElement>(null)
  const drag = useRef<Drag | null>(null)
  const press = useRef<LanePress | null>(null)
  const [width, setWidth] = useState(0)
  const duration = session.durationMs
  const { selection, timeMap } = state
  const { cues } = state.captions

  useEffect(() => {
    const element = tracks.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The playhead and the timecode follow the player directly, without re-rendering React.
  useEffect(
    () =>
      player.onTime((timeMs) => {
        if (playhead.current) {
          playhead.current.style.transform = `translateX(${(timeMs / duration) * width}px)`
        }
        if (timecode.current) {
          timecode.current.textContent = formatTimecode(sourceTimeToTimelineTime(timeMap, timeMs))
        }
      }),
    [player, duration, width, timeMap]
  )

  const timeAt = (clientX: number): number => {
    const bounds = tracks.current?.getBoundingClientRect()
    if (!bounds || bounds.width === 0) return 0
    return Math.min(Math.max(((clientX - bounds.left) / bounds.width) * duration, 0), duration)
  }

  const scrub = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.type === 'pointerdown') {
      event.currentTarget.setPointerCapture(event.pointerId)
      store.select(null)
    } else if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return
    }
    player.seek(timeAt(event.clientX))
  }

  // --- selecting on the video lane ----------------------------------------------

  const beginPress = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { originX: event.clientX, timeMs: timeAt(event.clientX), selecting: false }
  }

  const continuePress = (event: PointerEvent<HTMLDivElement>): void => {
    const current = press.current
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    if (!current.selecting && Math.abs(event.clientX - current.originX) < SELECT_THRESHOLD_PX) return
    current.selecting = true
    store.setSelection({ startMs: current.timeMs, endMs: timeAt(event.clientX) })
  }

  const endPress = (): void => {
    const current = press.current
    press.current = null
    if (!current || current.selecting) return
    // A plain click moves the playhead and drops any selection.
    store.select(null)
    store.setSelection(null)
    player.seek(current.timeMs)
  }

  /** Dragging one end of the selection; which end is told by the element's `data-edge`. */
  const grabSelectionEdge = (event: PointerEvent<HTMLElement>): void => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const dragSelectionEdge = (event: PointerEvent<HTMLElement>): void => {
    const current = store.getState().selection
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const timeMs = timeAt(event.clientX)
    store.setSelection(
      event.currentTarget.dataset['edge'] === 'start'
        ? { startMs: timeMs, endMs: current.endMs }
        : { startMs: current.startMs, endMs: timeMs }
    )
  }

  // --- dragging regions ---------------------------------------------------------

  const beginDrag = (next: Drag) => (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { ...next, originX: event.clientX }
    if (next.target === 'zoom') store.select(next.original.id)
    else if (next.target === 'trim') store.selectTrim(next.original.id)
    else {
      // A caption is only on screen during its own span: go there to see it.
      store.selectCue(next.original.id)
      if (next.kind === 'move') player.seek(next.original.startMs)
    }
  }

  const continueDrag = (event: PointerEvent<HTMLElement>): void => {
    const current = drag.current
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId) || width === 0) return
    const deltaMs = ((event.clientX - current.originX) / width) * duration
    if (current.kind === 'move' && deltaMs === 0) return
    const timeMs = timeAt(event.clientX)

    if (current.target === 'trim') {
      if (current.kind === 'move') store.moveTrim(current.original, deltaMs)
      else store.resizeTrim(current.original, current.kind, timeMs)
      return
    }
    if (current.target === 'cue') {
      if (current.kind === 'move') store.moveCue(current.original, deltaMs)
      else store.resizeCue(current.original, current.kind, timeMs)
      return
    }
    const zooms = store.getState().zooms
    store.setSpan(
      current.original.id,
      current.kind === 'move'
        ? moveZoom(zooms, current.original, deltaMs, duration)
        : resizeZoom(zooms, current.original, current.kind, timeMs, duration)
    )
  }

  const endDrag = (): void => {
    drag.current = null
    store.endGesture()
  }

  const percent = (timeMs: number): string => `${(timeMs / duration) * 100}%`
  const span = (region: { startMs: number; endMs: number }) => ({
    left: percent(region.startMs),
    width: percent(region.endMs - region.startMs)
  })
  const dragHandlers = { onPointerMove: continueDrag, onPointerUp: endDrag, onPointerCancel: endDrag }

  return (
    <section className="timeline">
      <header className="timeline-header">
        <span className="timeline-timecode" ref={timecode}>
          00:00,0
        </span>
        {selection ? (
          <div className="selection-bar">
            <span>
              Seleção {formatTimecode(selection.startMs)} – {formatTimecode(selection.endMs)}
            </span>
            <span className="badge">
              {((selection.endMs - selection.startMs) / 1000).toFixed(1).replace('.', ',')} s
            </span>
            <button className="selection-action" onClick={() => store.cutSelection()}>
              <ScissorsIcon /> Cortar seleção
            </button>
            <button
              className="selection-clear"
              aria-label="Limpar seleção"
              title="Limpar seleção (esc)"
              onClick={() => store.setSelection(null)}
            >
              <CloseIcon />
            </button>
          </div>
        ) : (
          <span className="timeline-hint">
            Arraste sobre o vídeo para selecionar um trecho · <kbd>I</kbd> <kbd>O</kbd> marcam início e fim ·{' '}
            <kbd>espaço</kbd> reproduz
          </span>
        )}
      </header>

      <div className="timeline-body">
        <div className="timeline-labels">
          <span className="timeline-label timeline-label-ruler" />
          <LaneLabel icon={<FilmIcon />} tall>
            Vídeo
          </LaneLabel>
          <LaneLabel icon={<ScissorsIcon />}>Cortes</LaneLabel>
          <LaneLabel icon={<ZoomIcon />}>Zoom</LaneLabel>
          {cues.length > 0 && <LaneLabel icon={<CaptionsIcon />}>Legendas</LaneLabel>}
          {session.webcam && (
            <LaneLabel icon={<CameraIcon />} tall>
              Câmera
            </LaneLabel>
          )}
          {session.audio.map((track) => (
            <LaneLabel key={track.kind} icon={AUDIO_LANES[track.kind].icon}>
              {AUDIO_LANES[track.kind].label}
            </LaneLabel>
          ))}
        </div>

        <div className="timeline-tracks" ref={tracks}>
          <div className="ruler" onPointerDown={scrub} onPointerMove={scrub}>
            {rulerMarks(duration, width).map((timeMs) => (
              <span key={timeMs} className="ruler-mark" style={{ left: percent(timeMs) }}>
                {formatClock(timeMs)}
              </span>
            ))}
          </div>

          <div
            className="lane lane-video"
            onPointerDown={beginPress}
            onPointerMove={continuePress}
            onPointerUp={endPress}
            onPointerCancel={endPress}
          >
            <Filmstrip
              url={session.video.url}
              durationMs={duration}
              aspect={session.video.widthPx / session.video.heightPx}
            />
            {session.interactions
              .filter((event) => CLICK_TYPES.has(event.type))
              .map((event, index) => (
                <span
                  key={index}
                  className="click-marker"
                  title={`Clique em ${formatTimecode(event.timeMs)}`}
                  style={{ left: percent(event.timeMs) }}
                />
              ))}
          </div>

          <div
            className="lane lane-trim"
            onPointerDown={scrub}
            onPointerMove={scrub}
            onDoubleClick={(event) => store.addTrim(timeAt(event.clientX))}
          >
            {state.trims.map((trim) => (
              <div
                key={trim.id}
                className="region trim-block"
                data-selected={trim.id === state.selectedTrimId}
                title={`Corte · ${formatTimecode(trim.startMs)} – ${formatTimecode(trim.endMs)}`}
                style={span(trim)}
                onPointerDown={beginDrag({ target: 'trim', kind: 'move', original: trim, originX: 0 })}
                onDoubleClick={(event) => event.stopPropagation()}
                {...dragHandlers}
              >
                <span
                  className="region-handle region-handle-start"
                  onPointerDown={beginDrag({ target: 'trim', kind: 'start', original: trim, originX: 0 })}
                  {...dragHandlers}
                />
                <span
                  className="region-handle region-handle-end"
                  onPointerDown={beginDrag({ target: 'trim', kind: 'end', original: trim, originX: 0 })}
                  {...dragHandlers}
                />
              </div>
            ))}
          </div>

          {/* Proposed cuts sit on the cuts lane, visibly not cuts yet. */}
          {state.suggestions.length > 0 && (
            <div className="suggestion-marks">
              {state.suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  className="suggestion-block"
                  aria-label={`Sugestão de corte: ${suggestion.text}`}
                  title={`Sugestão da IA · ${SUGGESTION_KIND_LABELS[suggestion.kind]} · ${suggestion.reason}`}
                  style={span(suggestion)}
                  onClick={() => previewSuggestion(store, player, suggestion)}
                />
              ))}
            </div>
          )}

          <div
            className="lane lane-zoom"
            onPointerDown={scrub}
            onPointerMove={scrub}
            onDoubleClick={(event) => store.addZoom(timeAt(event.clientX))}
          >
            {state.zooms.length === 0 && <span className="lane-hint">Clique duas vezes para adicionar um zoom</span>}
            {state.zooms.map((zoom) => (
              <div
                key={zoom.id}
                className="region zoom-block"
                data-mode={zoom.mode}
                data-selected={zoom.id === state.selectedZoomId}
                title={`${zoom.mode === 'auto' ? 'Zoom automático' : 'Zoom manual'} · ${formatTimecode(zoom.startMs)} – ${formatTimecode(zoom.endMs)}`}
                style={span(zoom)}
                onPointerDown={beginDrag({ target: 'zoom', kind: 'move', original: zoom, originX: 0 })}
                onDoubleClick={(event) => event.stopPropagation()}
                {...dragHandlers}
              >
                <span
                  className="region-handle region-handle-start"
                  onPointerDown={beginDrag({ target: 'zoom', kind: 'start', original: zoom, originX: 0 })}
                  {...dragHandlers}
                />
                <span className="zoom-label">{zoom.scale.toFixed(1).replace('.', ',')}×</span>
                <span
                  className="region-handle region-handle-end"
                  onPointerDown={beginDrag({ target: 'zoom', kind: 'end', original: zoom, originX: 0 })}
                  {...dragHandlers}
                />
              </div>
            ))}
          </div>

          {cues.length > 0 && (
            <div
              className="lane lane-caption"
              data-hidden={!state.captions.visible}
              onPointerDown={scrub}
              onPointerMove={scrub}
            >
              {cues.map((cue) => (
                <div
                  key={cue.id}
                  className="region cue-block"
                  data-selected={cue.id === state.selectedCueId}
                  title={`${cue.text} · ${formatTimecode(cue.startMs)} – ${formatTimecode(cue.endMs)}`}
                  style={span(cue)}
                  onPointerDown={beginDrag({ target: 'cue', kind: 'move', original: cue, originX: 0 })}
                  {...dragHandlers}
                >
                  <span
                    className="region-handle region-handle-start"
                    onPointerDown={beginDrag({ target: 'cue', kind: 'start', original: cue, originX: 0 })}
                    {...dragHandlers}
                  />
                  <span className="cue-label">{cue.text}</span>
                  <span
                    className="region-handle region-handle-end"
                    onPointerDown={beginDrag({ target: 'cue', kind: 'end', original: cue, originX: 0 })}
                    {...dragHandlers}
                  />
                </div>
              ))}
            </div>
          )}

          {session.webcam && (
            <div className="lane lane-companion lane-webcam">
              <Filmstrip
                url={session.webcam.url}
                durationMs={duration}
                aspect={session.webcam.widthPx / session.webcam.heightPx}
              />
            </div>
          )}
          {session.audio.map((track) => (
            <div key={track.kind} className="lane lane-companion lane-audio">
              <Waveform sessionId={session.sessionId} track={track.kind} />
            </div>
          ))}

          {/* What a cut removes is dimmed across every lane. */}
          {state.trims.map((trim) => (
            <div key={trim.id} className="cut-shade" style={span(trim)} />
          ))}
          {selection && (
            <div className="selection-band" style={span(selection)}>
              <span
                className="selection-edge selection-edge-start"
                data-edge="start"
                onPointerDown={grabSelectionEdge}
                onPointerMove={dragSelectionEdge}
              />
              <span
                className="selection-edge selection-edge-end"
                data-edge="end"
                onPointerDown={grabSelectionEdge}
                onPointerMove={dragSelectionEdge}
              />
            </div>
          )}
          <div className="playhead" ref={playhead} />
        </div>
      </div>
    </section>
  )
}
