import type { PointerEvent, ReactNode } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sourceTimeToTimelineTime } from '@engine/time/timeMapping'
import { moveZoom, resizeZoom } from '@engine/zoom/zoomEditing'
import { formatClock, formatTimecode } from '@shared/format'
import { DUB_TRACKS } from '@shared/models/media'
import type { EditorSession } from '@shared/models/editor'
import type { CaptionCue, TextOverlay, TrimEffect, ZoomEffect } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import { Filmstrip } from './Filmstrip'
import type { PreviewPlayer } from './PreviewPlayer'
import { SUGGESTION_KIND_LABELS, previewSuggestion } from './SuggestionsPanel'
import { Waveform } from './Waveform'
import {
  CameraIcon,
  CaptionsIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  FilmIcon,
  FitIcon,
  LockIcon,
  MagnetIcon,
  PlusIcon,
  MicIcon,
  MutedIcon,
  VoiceIcon,
  ScissorsIcon,
  SpeakerIcon,
  TextIcon,
  TrashIcon,
  UnlockIcon,
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
  | { target: 'text'; original: TextOverlay }
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
/** Room a ruler label takes to the right of its mark ("00:35" plus padding). */
const RULER_LABEL_WIDTH_PX = 44
/** Pointer travel that turns a click on the video lane into a selection. */
const SELECT_THRESHOLD_PX = 3
/** A region narrower than this on screen does not get the trash button. */
const REMOVE_MIN_WIDTH_PX = 64
/** With snapping on, an edge this close (on screen) to another edge or the playhead lands on it. */
const SNAP_PX = 8
/** How far the tracks can be stretched beyond the window, horizontally. */
const ZOOM_LEVELS = { min: 1, max: 8, step: 0.25 } as const
const SNAP_KEY = 'screenrx.timeline.snap'

/** A lane whose regions the user froze: nothing on it moves until it is unlocked. */
type LaneId = 'cuts' | 'zoom' | 'captions' | 'text'

function readSnap(): boolean {
  try {
    return window.localStorage.getItem(SNAP_KEY) !== 'off'
  } catch {
    return true
  }
}

const AUDIO_LANES = {
  microphone: { label: 'Microfone', name: 'o microfone', icon: <MicIcon /> },
  systemAudio: { label: 'Sistema', name: 'o som do sistema', icon: <SpeakerIcon /> }
} as const

function rulerMarks(durationMs: number, widthPx: number): number[] {
  if (widthPx <= 0 || durationMs <= 0) return []
  const pxPerSecond = widthPx / (durationMs / 1000)
  const step = RULER_STEPS_S.find((seconds) => seconds * pxPerSecond >= MIN_LABEL_SPACING_PX) ?? 600
  // A label that would run past the right edge is left out, so the tracks never grow a scrollbar.
  const lastLabelStartMs = ((widthPx - RULER_LABEL_WIDTH_PX) / pxPerSecond) * 1000
  const marks: number[] = []
  for (let seconds = 0; seconds * 1000 <= Math.min(durationMs, lastLabelStartMs); seconds += step) marks.push(seconds * 1000)
  return marks
}

function LaneLabel({
  icon,
  children,
  tall,
  onAdd,
  addLabel,
  locked,
  onLock
}: {
  icon: ReactNode
  children: ReactNode
  tall?: boolean
  /** Offers a "+" that adds one of the lane's regions at the playhead. */
  onAdd?: () => void
  addLabel?: string
  /** Offers a lock that freezes the lane's regions. */
  locked?: boolean
  onLock?: () => void
}) {
  return (
    <span className="timeline-label" data-tall={tall === true} data-locked={locked === true}>
      {icon}
      <span className="timeline-label-text">{children}</span>
      {onAdd && (
        <button className="lane-add" aria-label={addLabel} title={addLabel} disabled={locked} onClick={onAdd}>
          <PlusIcon />
        </button>
      )}
      {onLock && (
        <button
          className="lane-lock"
          role="switch"
          aria-checked={locked === true}
          aria-label={locked ? 'Destravar a pista' : 'Travar a pista'}
          title={locked ? 'Travada: nada nesta pista se move. Clique para destravar.' : 'Travar a pista: nada nela se move.'}
          onClick={onLock}
        >
          {locked ? <LockIcon /> : <UnlockIcon />}
        </button>
      )}
    </span>
  )
}

/** The label of a lane whose regions can be hidden from the video, doubling as the switch. */
function VisibilityLabel({
  icon,
  children,
  visible,
  tall,
  name,
  onToggle
}: {
  icon: ReactNode
  children: ReactNode
  visible: boolean
  tall?: boolean
  name: string
  onToggle: () => void
}) {
  return (
    <button
      className="timeline-label timeline-label-toggle"
      role="switch"
      aria-checked={visible}
      aria-label={`Mostrar ${name}`}
      title={visible ? `Clique para ocultar ${name} no vídeo.` : `Oculto: ${name} não aparece no vídeo. Clique para mostrar.`}
      data-tall={tall === true}
      data-hidden={!visible}
      onClick={onToggle}
    >
      {icon}
      <span className="timeline-label-text">{children}</span>
      <span className="lane-eye" aria-hidden="true">
        {visible ? <EyeIcon /> : <EyeOffIcon />}
      </span>
    </button>
  )
}

/** The trash on a selected region, when the region is wide enough to hold it. */
function RegionRemove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      className="region-remove"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onRemove()
      }}
    >
      <TrashIcon />
    </button>
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
  const [snap, setSnap] = useState(readSnap)
  const [zoom, setZoom] = useState(1)
  const [locked, setLocked] = useState<ReadonlySet<LaneId>>(() => new Set())
  const scroll = useRef<HTMLDivElement>(null)
  const duration = session.durationMs
  const { selection, timeMap } = state
  const { cues } = state.captions
  // The dubbing in use has a lane of its own; it stands in for the microphone.
  const dub = state.dubs.find((track) => track.language === state.dub.language) ?? null
  const laneCount = 4 + (cues.length > 0 ? 1 : 0) + (session.webcam ? 1 : 0) + session.audio.length + (dub ? 1 : 0)

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
        const text = formatTimecode(sourceTimeToTimelineTime(timeMap, timeMs))
        const x = (timeMs / duration) * width
        if (playhead.current) {
          playhead.current.style.transform = `translateX(${x}px)`
          const pill = playhead.current.firstElementChild
          if (pill) pill.textContent = text
        }
        if (timecode.current) timecode.current.textContent = text
        // Stretched beyond the window, the tracks scroll to keep the playhead in sight.
        const viewport = scroll.current
        if (viewport && (x < viewport.scrollLeft || x > viewport.scrollLeft + viewport.clientWidth)) {
          viewport.scrollLeft = Math.max(0, x - viewport.clientWidth / 3)
        }
      }),
    [player, duration, width, timeMap]
  )

  const rawTimeAt = (clientX: number): number => {
    const bounds = tracks.current?.getBoundingClientRect()
    if (!bounds || bounds.width === 0) return 0
    return Math.min(Math.max(((clientX - bounds.left) / bounds.width) * duration, 0), duration)
  }

  /** The instants an edge lands on when snapping: the ends, the playhead and every region's edges. */
  const snapTargets = (except?: string): number[] => {
    const targets = [0, duration, player.currentTimeMs]
    for (const region of [...state.trims, ...state.zooms, ...cues, ...state.texts]) {
      if (region.id === except) continue
      targets.push(region.startMs, region.endMs)
    }
    return targets
  }

  /** `timeMs`, or the snap target within reach of it on screen. */
  const snapped = (timeMs: number, except?: string): number => {
    if (!snap || width === 0) return timeMs
    const reach = (SNAP_PX / width) * duration
    let best = timeMs
    let bestDistance = reach
    for (const target of snapTargets(except)) {
      const distance = Math.abs(target - timeMs)
      if (distance < bestDistance) {
        best = target
        bestDistance = distance
      }
    }
    return best
  }

  const timeAt = (clientX: number, except?: string): number => snapped(rawTimeAt(clientX), except)

  /** Removes whatever region is selected, as Backspace does. */
  const removeSelected = (): void => {
    if (store.selectedZoom) store.removeZoom(store.selectedZoom.id)
    else if (store.selectedTrim) store.removeTrim(store.selectedTrim.id)
    else if (store.selectedCue) store.removeCue(store.selectedCue.id)
    else if (store.selectedText) store.removeText(store.selectedText.id)
  }
  const hasSelection = Boolean(store.selectedZoom || store.selectedTrim || store.selectedCue || store.selectedText)

  const toggleSnap = (): void => {
    setSnap((value) => {
      try {
        window.localStorage.setItem(SNAP_KEY, value ? 'off' : 'on')
      } catch {
        // Not remembering the choice is no reason to fail.
      }
      return !value
    })
  }
  const setZoomLevel = (level: number): void => setZoom(Math.min(ZOOM_LEVELS.max, Math.max(ZOOM_LEVELS.min, level)))
  const isLocked = (lane: LaneId): boolean => locked.has(lane)
  const toggleLock = (lane: LaneId): void =>
    setLocked((current) => {
      const next = new Set(current)
      if (next.has(lane)) next.delete(lane)
      else next.add(lane)
      return next
    })

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
    else if (next.target === 'text') {
      store.selectText(next.original.id)
      if (next.kind === 'move') player.seek(next.original.startMs)
    } else {
      // A caption is only on screen during its own span: go there to see it.
      store.selectCue(next.original.id)
      if (next.kind === 'move') player.seek(next.original.startMs)
    }
  }

  const continueDrag = (event: PointerEvent<HTMLElement>): void => {
    const current = drag.current
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId) || width === 0) return
    const rawDelta = ((event.clientX - current.originX) / width) * duration
    // Moving: whichever edge comes within reach of a target pulls the whole region onto it.
    const startSnap = snapped(current.original.startMs + rawDelta, current.original.id) - (current.original.startMs + rawDelta)
    const endSnap = snapped(current.original.endMs + rawDelta, current.original.id) - (current.original.endMs + rawDelta)
    const deltaMs = rawDelta + (Math.abs(startSnap) <= Math.abs(endSnap) ? startSnap : endSnap)
    if (current.kind === 'move' && deltaMs === 0) return
    const timeMs = timeAt(event.clientX, current.original.id)

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
    if (current.target === 'text') {
      if (current.kind === 'move') store.moveText(current.original, deltaMs)
      else store.resizeText(current.original, current.kind, timeMs)
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
  /** Whether a region is wide enough on screen for the trash beside its label. */
  const roomy = (region: { startMs: number; endMs: number }): boolean =>
    ((region.endMs - region.startMs) / duration) * width >= REMOVE_MIN_WIDTH_PX
  const now = (): number => player.currentTimeMs
  const dragHandlers = { onPointerMove: continueDrag, onPointerUp: endDrag, onPointerCancel: endDrag }

  return (
    <section className="timeline">
      <header className="timeline-header">
        <div className="timeline-tools">
          <button className="timeline-tool" disabled={!hasSelection} title="Remover a região selecionada (⌫)" onClick={removeSelected}>
            <TrashIcon /> Remover
          </button>
          <button
            className="timeline-tool"
            role="switch"
            aria-checked={snap}
            title={snap ? 'Encaixar: as bordas grudam nos cortes, nas regiões e no cursor. Clique para desligar.' : 'Encaixar as bordas nos cortes, nas regiões e no cursor.'}
            onClick={toggleSnap}
          >
            <MagnetIcon /> Encaixar
          </button>
        </div>
        <span className="timeline-clock">
          <span className="timeline-timecode" ref={timecode}>
            00:00,0
          </span>
          <span className="timeline-total">/ {formatTimecode(timeMap.timelineDurationMs)}</span>
        </span>
        <div className="timeline-zoom">
          <button className="timeline-tool timeline-tool-icon" aria-label="Afastar" title="Afastar" disabled={zoom <= ZOOM_LEVELS.min} onClick={() => setZoomLevel(zoom - 1)}>
            −
          </button>
          <input
            type="range"
            className="timeline-zoom-slider"
            aria-label="Zoom da linha do tempo"
            min={ZOOM_LEVELS.min}
            max={ZOOM_LEVELS.max}
            step={ZOOM_LEVELS.step}
            value={zoom}
            onChange={(event) => setZoomLevel(Number(event.target.value))}
          />
          <button className="timeline-tool timeline-tool-icon" aria-label="Aproximar" title="Aproximar" disabled={zoom >= ZOOM_LEVELS.max} onClick={() => setZoomLevel(zoom + 1)}>
            +
          </button>
          <button className="timeline-tool timeline-tool-icon" aria-label="Ajustar à janela" title="Ajustar à janela" disabled={zoom === 1} onClick={() => setZoomLevel(1)}>
            <FitIcon />
          </button>
        </div>
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
        ) : null}
      </header>

      <div className="timeline-body">
        <div className="timeline-labels">
          <span className="timeline-label timeline-label-ruler timeline-track-count">
            {laneCount} {laneCount === 1 ? 'trilha' : 'trilhas'}
          </span>
          <LaneLabel icon={<FilmIcon />} tall>
            Vídeo
          </LaneLabel>
          <LaneLabel
            icon={<ScissorsIcon />}
            onAdd={() => store.addTrim(now())}
            addLabel="Cortar a partir daqui"
            locked={isLocked('cuts')}
            onLock={() => toggleLock('cuts')}
          >
            Cortes
          </LaneLabel>
          <LaneLabel
            icon={<ZoomIcon />}
            onAdd={() => store.addZoom(now())}
            addLabel="Adicionar zoom aqui"
            locked={isLocked('zoom')}
            onLock={() => toggleLock('zoom')}
          >
            Zoom
          </LaneLabel>
          {cues.length > 0 && (
            <VisibilityLabel
              icon={<CaptionsIcon />}
              visible={state.captions.visible}
              name="as legendas"
              onToggle={() => store.setCaptionsVisible(!state.captions.visible)}
            >
              Legendas
            </VisibilityLabel>
          )}
          <LaneLabel
            icon={<TextIcon />}
            onAdd={() => store.addText(now())}
            addLabel="Adicionar texto aqui"
            locked={isLocked('text')}
            onLock={() => toggleLock('text')}
          >
            Texto
          </LaneLabel>
          {session.webcam && (
            <VisibilityLabel
              icon={<CameraIcon />}
              visible={state.webcam.visible}
              name="a câmera"
              tall
              onToggle={() => store.setWebcam({ visible: !state.webcam.visible })}
            >
              Câmera
            </VisibilityLabel>
          )}
          {session.audio.map((track) => {
            const lane = AUDIO_LANES[track.kind]
            const replaced = track.kind === 'microphone' && dub !== null
            const muted = state.audio[track.kind].muted || replaced
            return (
              <button
                key={track.kind}
                className="timeline-label timeline-label-toggle"
                role="switch"
                aria-checked={!muted}
                aria-label={`Som d${lane.name}`}
                disabled={replaced}
                title={
                  replaced
                    ? 'A dublagem em uso toca no lugar do microfone.'
                    : muted
                      ? `Silenciado: ${lane.name} não toca nem vai para o vídeo exportado. Clique para ativar.`
                      : `Clique para silenciar ${lane.name} no preview e no vídeo exportado.`
                }
                data-muted={muted}
                onClick={() => store.setTrackMuted(track.kind, !muted)}
              >
                {muted ? <MutedIcon /> : lane.icon}
                <span>{lane.label}</span>
              </button>
            )
          })}
          {dub && <LaneLabel icon={<VoiceIcon />}>Dublagem</LaneLabel>}
        </div>

        <div className="timeline-scroll" ref={scroll}>
        <div className="timeline-tracks" ref={tracks} style={{ width: `${zoom * 100}%` }}>
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
            {timeMap.segments.map((segment) => (
              <span
                key={segment.sourceStartMs}
                className="clip-label"
                style={{ left: percent(segment.sourceStartMs), maxWidth: percent(segment.sourceEndMs - segment.sourceStartMs) }}
              >
                <span className="clip-label-name">{session.title}</span>
                <span className="clip-label-length">{((segment.sourceEndMs - segment.sourceStartMs) / 1000).toFixed(1).replace('.', ',')} s</span>
              </span>
            ))}
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
            data-locked={isLocked('cuts')}
            onPointerDown={scrub}
            onPointerMove={scrub}
            onDoubleClick={(event) => !isLocked('cuts') && store.addTrim(timeAt(event.clientX))}
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
                {roomy(trim) && (
                  <span className="cut-badge">
                    <ScissorsIcon /> {((trim.endMs - trim.startMs) / 1000).toFixed(1).replace('.', ',')} s
                  </span>
                )}
                {trim.id === state.selectedTrimId && roomy(trim) && (
                  <RegionRemove label="Desfazer este corte" onRemove={() => store.removeTrim(trim.id)} />
                )}
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
            data-locked={isLocked('zoom')}
            onPointerDown={scrub}
            onPointerMove={scrub}
            onDoubleClick={(event) => !isLocked('zoom') && store.addZoom(timeAt(event.clientX))}
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
                {zoom.id === state.selectedZoomId && roomy(zoom) && (
                  <RegionRemove label="Remover este zoom" onRemove={() => store.removeZoom(zoom.id)} />
                )}
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
              data-locked={isLocked('captions')}
              onPointerDown={scrub}
              onPointerMove={scrub}
            >
              {cues.map((cue) => (
                <div
                  key={cue.id}
                  className="region cue-block"
                  data-selected={cue.id === state.selectedCueId}
                  title={`${store.textOf(cue)} · ${formatTimecode(cue.startMs)} – ${formatTimecode(cue.endMs)}`}
                  style={span(cue)}
                  onPointerDown={beginDrag({ target: 'cue', kind: 'move', original: cue, originX: 0 })}
                  {...dragHandlers}
                >
                  <span
                    className="region-handle region-handle-start"
                    onPointerDown={beginDrag({ target: 'cue', kind: 'start', original: cue, originX: 0 })}
                    {...dragHandlers}
                  />
                  <span className="region-icon" aria-hidden="true">
                    <CaptionsIcon />
                  </span>
                  <span className="cue-label">{store.textOf(cue)}</span>
                  {cue.id === state.selectedCueId && roomy(cue) && (
                    <RegionRemove label="Remover esta legenda" onRemove={() => store.removeCue(cue.id)} />
                  )}
                  <span
                    className="region-handle region-handle-end"
                    onPointerDown={beginDrag({ target: 'cue', kind: 'end', original: cue, originX: 0 })}
                    {...dragHandlers}
                  />
                </div>
              ))}
            </div>
          )}

          <div
            className="lane lane-text"
            data-locked={isLocked('text')}
            onPointerDown={scrub}
            onPointerMove={scrub}
            onDoubleClick={(event) => !isLocked('text') && store.addText(timeAt(event.clientX))}
          >
            {state.texts.length === 0 && <span className="lane-hint">Clique duas vezes para adicionar um texto</span>}
            {state.texts.map((text) => (
                <div
                  key={text.id}
                  className="region text-block"
                  data-selected={text.id === state.selectedTextId}
                  title={`${text.text} · ${formatTimecode(text.startMs)} – ${formatTimecode(text.endMs)}`}
                  style={span(text)}
                  onPointerDown={beginDrag({ target: 'text', kind: 'move', original: text, originX: 0 })}
                  onDoubleClick={(event) => event.stopPropagation()}
                  {...dragHandlers}
                >
                  <span
                    className="region-handle region-handle-start"
                    onPointerDown={beginDrag({ target: 'text', kind: 'start', original: text, originX: 0 })}
                    {...dragHandlers}
                  />
                  <span className="region-icon region-icon-text" aria-hidden="true">
                    Tt
                  </span>
                  <span className="cue-label">“{text.text}”</span>
                  {text.id === state.selectedTextId && roomy(text) && (
                    <RegionRemove label="Remover este texto" onRemove={() => store.removeText(text.id)} />
                  )}
                  <span
                    className="region-handle region-handle-end"
                    onPointerDown={beginDrag({ target: 'text', kind: 'end', original: text, originX: 0 })}
                    {...dragHandlers}
                  />
                </div>
              ))}
          </div>

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
            <div
              key={track.kind}
              className="lane lane-companion lane-audio"
              data-muted={state.audio[track.kind].muted || (track.kind === 'microphone' && dub !== null)}
            >
              <Waveform sessionId={session.sessionId} track={track.kind} />
              <span className="clip-label clip-label-audio">
                {AUDIO_LANES[track.kind].label}
                {(state.audio[track.kind].muted || (track.kind === 'microphone' && dub !== null)) && ' · mudo'}
              </span>
            </div>
          ))}

          {dub && (
            <div className="lane lane-companion lane-audio lane-dub">
              {/* Keyed by its address: a dubbing generated again is drawn again. */}
              <Waveform key={dub.url} sessionId={session.sessionId} track={DUB_TRACKS[dub.language]} />
              <span className="clip-label clip-label-audio">Dublagem · {dub.language.toUpperCase()}</span>
            </div>
          )}

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
          <div className="playhead" ref={playhead}>
            <span className="playhead-time">00:00,0</span>
          </div>
        </div>
        </div>
      </div>
    </section>
  )
}
