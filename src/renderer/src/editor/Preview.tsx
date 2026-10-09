import type { PointerEvent } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { findBackgroundPreset } from '@engine/rendering/backgrounds'
import type { Rect } from '@engine/rendering/frameLayout'
import { containsPoint, layoutFrame, layoutWebcam, sourceCrop } from '@engine/rendering/frameLayout'
import type { EditorSession } from '@shared/models/editor'
import { frameToSource, outputToFrame } from '../rendering/composeFrame'
import type { EditorState, EditorStore } from './EditorStore'
import type { PreviewSettings } from './PreviewPlayer'
import { frameCorners, textSelectionFrame } from './PreviewPlayer'
import { safeAreas } from '../common/safeAreas'
import { PreviewPlayer } from './PreviewPlayer'

interface Props {
  session: EditorSession
  store: EditorStore
  onPlayerReady: (player: PreviewPlayer | null) => void
}

/** What a press on the picture is doing. */
type Press =
  | { kind: 'webcam'; grabX: number; grabY: number }
  | { kind: 'caption'; grabX: number; grabY: number }
  | { kind: 'text'; id: string; grabX: number; grabY: number }
  /** Dragging a corner handle of the selected text: the size follows the distance from the text's centre. */
  | { kind: 'text-resize'; id: string; centerX: number; centerY: number; startDistance: number; startSize: number }
  | { kind: 'picture' }
  /** Dragging the part of the recording in use, when it fills a frame of another shape. */
  | { kind: 'crop'; startX: number; startY: number; cropX: number; cropY: number }
  /** Drawing the rectangle around the object to follow, in output pixels. */
  | { kind: 'mark'; startX: number; startY: number }

/** Within this distance of the output's centre (as a share of it), a dragged object snaps to the centre. */
const CENTRE_SNAP = 0.015

/**
 * Snaps a dragged object's centre to the output's centre lines when it comes
 * close, and shows the lines it snapped to, as drawing apps do.
 */
function snapToCentre(player: PreviewPlayer, x: number, y: number): { x: number; y: number } {
  const vertical = Math.abs(x - 0.5) < CENTRE_SNAP
  const horizontal = Math.abs(y - 0.5) < CENTRE_SNAP
  player.setGuides({ vertical, horizontal })
  return { x: vertical ? 0.5 : x, y: horizontal ? 0.5 : y }
}

const settingsOf = (state: EditorState): PreviewSettings => ({
  timeMap: state.timeMap,
  zooms: state.zooms,
  background: state.background,
  webcam: state.webcam,
  captions: state.captions,
  texts: state.texts,
  selectedTextId: state.selectedTextId,
  safeAreas: safeAreas.getState(),
  objectTrack: state.objectTrack,
  audio: state.audio,
  dubUrl: state.dubs.find((dub) => dub.language === state.dub.language)?.url ?? null,
  speed: state.exportSettings.speed,
  screenUrl: state.screenUrl,
  color: state.filters.color
})

/**
 * The canvas showing the finished look — backdrop, zooms, webcam, captions —
 * in real time. The webcam and the caption can be dragged to where they
 * should sit; with a zoom selected, clicking the picture moves the zoom's
 * focus there.
 */
export function Preview({ session, store, onPlayerReady }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const player = useRef<PreviewPlayer | null>(null)
  const press = useRef<Press | null>(null)
  const [failed, setFailed] = useState(false)
  /** The rectangle being drawn to mark an object, in CSS pixels over the canvas, while the pointer is down. */
  const [marking, setMarking] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const state = useSyncExternalStore(store.subscribe, store.getState)

  useEffect(() => {
    if (!canvas.current) return
    const instance = new PreviewPlayer(canvas.current, session, settingsOf(store.getState()))
    player.current = instance
    const stopListening = instance.onError(() => setFailed(true))
    // The player redraws itself whenever the project (or a preview preference) changes.
    const unsubscribe = store.subscribe(() => instance.update(settingsOf(store.getState())))
    const unsubscribeSafeAreas = safeAreas.subscribe(() => instance.update(settingsOf(store.getState())))
    onPlayerReady(instance)
    return () => {
      unsubscribe()
      unsubscribeSafeAreas()
      stopListening()
      onPlayerReady(null)
      player.current = null
      instance.destroy()
    }
  }, [session, store, onPlayerReady])

  /** The pointer position in output pixels, and what of the webcam and the caption is under it. */
  const locate = (event: PointerEvent<HTMLCanvasElement>) => {
    const instance = player.current
    if (!instance) return null
    const output = instance.outputSize
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - bounds.left) / bounds.width) * output.width
    const y = ((event.clientY - bounds.top) / bounds.height) * output.height
    const { webcam } = store.getState()
    const picture = session.webcam && webcam.visible ? layoutWebcam(output, webcam) : null
    const caption = instance.captionBox
    // The text drawn last is on top, so it is the one a press lands on.
    const text = [...instance.textBoxes].reverse().find((candidate) => containsPoint(candidate.box, x, y)) ?? null
    // A corner handle of the selected text is grabbed before anything under it.
    const { selectedTextId } = store.getState()
    const selected = instance.textBoxes.find((candidate) => candidate.id === selectedTextId) ?? null
    let handle: { id: string; box: Rect; corner: number } | null = null
    if (selected) {
      const { frame, handle: side } = textSelectionFrame(selected.box, output)
      const reach = side
      const corner = frameCorners(frame).findIndex((point) => Math.abs(point.x - x) <= reach && Math.abs(point.y - y) <= reach)
      if (corner >= 0) handle = { id: selected.id, box: selected.box, corner }
    }
    return {
      instance,
      output,
      x,
      y,
      picture: picture && containsPoint(picture, x, y) ? picture : null,
      caption: caption && containsPoint(caption, x, y) ? caption : null,
      text,
      handle
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    const at = locate(event)
    if (!at) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // Texts are drawn over everything, then the caption: a press lands on the topmost.
    const grabbed = at.text?.box ?? at.caption ?? at.picture
    const { background, selectedZoomId } = store.getState()
    const cropping = background.aspect !== 'native' && background.fit === 'fill' && selectedZoomId === null
    if (state.markingObject) {
      press.current = { kind: 'mark', startX: at.x, startY: at.y }
      return
    }
    if (at.handle) {
      const centerX = at.handle.box.x + at.handle.box.width / 2
      const centerY = at.handle.box.y + at.handle.box.height / 2
      const text = store.getState().texts.find((candidate) => candidate.id === at.handle?.id)
      press.current = {
        kind: 'text-resize',
        id: at.handle.id,
        centerX,
        centerY,
        startDistance: Math.max(1, Math.hypot(at.x - centerX, at.y - centerY)),
        startSize: text?.style.sizeRatio ?? 0.07
      }
      return
    }
    if (at.text) store.selectText(at.text.id)
    // A press anywhere else lets go of the selected text: its frame and panel are gone.
    else if (!at.handle && store.getState().selectedTextId) store.selectText(null)
    press.current = at.text
      ? { kind: 'text', id: at.text.id, grabX: at.x - (at.text.box.x + at.text.box.width / 2), grabY: at.y - (at.text.box.y + at.text.box.height / 2) }
      : grabbed
      ? {
          kind: at.caption ? 'caption' : 'webcam',
          grabX: at.x - (grabbed.x + grabbed.width / 2),
          grabY: at.y - (grabbed.y + grabbed.height / 2)
        }
      : cropping
        ? { kind: 'crop', startX: at.x, startY: at.y, cropX: background.crop.x, cropY: background.crop.y }
        : { kind: 'picture' }
  }

  const sourceSize = { width: session.video.widthPx, height: session.video.heightPx }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const at = locate(event)
    if (!at) return
    const current = press.current
    if (current?.kind === 'webcam') {
      // Dragging frees the webcam from its corner.
      const position = snapToCentre(at.instance, (at.x - current.grabX) / at.output.width, (at.y - current.grabY) / at.output.height)
      store.setWebcam({ corner: null, position }, 'webcam-move')
      return
    }
    if (current?.kind === 'crop') {
      // The picture follows the pointer: moving it right brings the part to its left into view.
      const { background } = store.getState()
      const framed = findBackgroundPreset(background.presetId) !== null
      const { frame } = layoutFrame(at.output, sourceSize, background, framed)
      const crop = sourceCrop(at.output, sourceSize, background)
      store.setBackground(
        {
          crop: {
            x: current.cropX - ((at.x - current.startX) / frame.width) * crop.width,
            y: current.cropY - ((at.y - current.startY) / frame.height) * crop.height
          }
        },
        'crop-move'
      )
      return
    }
    if (current?.kind === 'mark') {
      // Output pixels → CSS pixels of the canvas, measured here rather than while rendering.
      const element = event.currentTarget
      const scaleX = element.clientWidth / at.output.width
      const scaleY = element.clientHeight / at.output.height
      setMarking({
        left: element.offsetLeft + Math.min(current.startX, at.x) * scaleX,
        top: element.offsetTop + Math.min(current.startY, at.y) * scaleY,
        width: Math.abs(at.x - current.startX) * scaleX,
        height: Math.abs(at.y - current.startY) * scaleY
      })
      return
    }
    if (current?.kind === 'text-resize') {
      // Pulling a corner away from the centre enlarges the text in proportion; towards it, shrinks.
      const distance = Math.hypot(at.x - current.centerX, at.y - current.centerY)
      store.setTextStyle(current.id, { sizeRatio: current.startSize * (distance / current.startDistance) }, 'text-resize')
      return
    }
    if (current?.kind === 'text') {
      const position = snapToCentre(at.instance, (at.x - current.grabX) / at.output.width, (at.y - current.grabY) / at.output.height)
      store.setTextStyle(current.id, { position }, 'text-move')
      return
    }
    if (current?.kind === 'caption') {
      const position = snapToCentre(at.instance, (at.x - current.grabX) / at.output.width, (at.y - current.grabY) / at.output.height)
      store.setCaptionStyle({ position }, 'caption-move')
      return
    }
    const { background, selectedZoomId } = store.getState()
    event.currentTarget.style.cursor = at.handle
      ? at.handle.corner === 0 || at.handle.corner === 3
        ? 'nwse-resize'
        : 'nesw-resize'
      : at.text || at.caption || at.picture
      ? 'grab'
      : selectedZoomId !== null
        ? 'crosshair'
        : background.aspect !== 'native' && background.fit === 'fill'
          ? 'move'
          : 'default'
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const current = press.current
    press.current = null
    if (current?.kind === 'mark') {
      setMarking(null)
      const at = locate(event)
      if (!at) return
      // The rectangle, in the recording's own coordinates: each corner goes through the frame and the crop.
      const { background } = store.getState()
      const corner = (x: number, y: number) => {
        const onFrame = outputToFrame(at.output, sourceSize, background, x / at.output.width, y / at.output.height)
        return onFrame
          ? frameToSource(at.output, sourceSize, background, at.instance.camera, at.instance.pointer, at.instance.object, onFrame.x, onFrame.y)
          : null
      }
      const a = corner(Math.min(current.startX, at.x), Math.min(current.startY, at.y))
      const b = corner(Math.max(current.startX, at.x), Math.max(current.startY, at.y))
      if (!a || !b || b.x - a.x < 0.01 || b.y - a.y < 0.01) return
      void store.startObjectTracking(
        {
          startMs: at.instance.currentTimeMs,
          rect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
          // Followed in the picture being shown, so the track matches it.
          source: store.getState().trackingSource
        },
        (sessionId, request) => window.screenrx.track.start(sessionId, request)
      )
      return
    }
    if (
      current?.kind === 'webcam' ||
      current?.kind === 'caption' ||
      current?.kind === 'text' ||
      current?.kind === 'text-resize' ||
      current?.kind === 'crop'
    ) {
      player.current?.setGuides({ vertical: false, horizontal: false })
      store.endGesture()
      return
    }
    // With a zoom selected, a click on the recording moves its focus to that point.
    const at = locate(event)
    const zoom = store.selectedZoom
    if (!current || !at || !zoom) return
    const { background } = store.getState()
    const onFrame = outputToFrame(at.output, sourceSize, background, at.x / at.output.width, at.y / at.output.height)
    if (onFrame) {
      store.setFocus(
        zoom.id,
        frameToSource(at.output, sourceSize, background, at.instance.camera, at.instance.pointer, at.instance.object, onFrame.x, onFrame.y)
      )
    }
  }

  return (
    <div className="preview">
      <canvas
        ref={canvas}
        className="preview-canvas"
        data-pick-focus={state.selectedZoomId !== null}
        data-marking={state.markingObject}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null
          store.endGesture()
        }}
      />
      {marking && <span className="mark-rect" style={marking} />}
      {failed && <p className="editor-message">Não foi possível reproduzir este vídeo.</p>}
    </div>
  )
}
