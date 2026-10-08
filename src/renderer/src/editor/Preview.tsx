import type { PointerEvent } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { findBackgroundPreset } from '@engine/rendering/backgrounds'
import { containsPoint, layoutFrame, layoutWebcam, sourceCrop } from '@engine/rendering/frameLayout'
import type { EditorSession } from '@shared/models/editor'
import { frameToSource, outputToFrame } from '../rendering/composeFrame'
import type { EditorState, EditorStore } from './EditorStore'
import type { PreviewSettings } from './PreviewPlayer'
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
  | { kind: 'picture' }
  /** Dragging the part of the recording in use, when it fills a frame of another shape. */
  | { kind: 'crop'; startX: number; startY: number; cropX: number; cropY: number }

const settingsOf = (state: EditorState): PreviewSettings => ({
  timeMap: state.timeMap,
  zooms: state.zooms,
  background: state.background,
  webcam: state.webcam,
  captions: state.captions,
  texts: state.texts,
  audio: state.audio,
  dubUrl: state.dubs.find((dub) => dub.language === state.dub.language)?.url ?? null,
  speed: state.exportSettings.speed
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
  const state = useSyncExternalStore(store.subscribe, store.getState)

  useEffect(() => {
    if (!canvas.current) return
    const instance = new PreviewPlayer(canvas.current, session, settingsOf(store.getState()))
    player.current = instance
    const stopListening = instance.onError(() => setFailed(true))
    // The player redraws itself whenever the project changes.
    const unsubscribe = store.subscribe(() => instance.update(settingsOf(store.getState())))
    onPlayerReady(instance)
    return () => {
      unsubscribe()
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
    return {
      instance,
      output,
      x,
      y,
      picture: picture && containsPoint(picture, x, y) ? picture : null,
      caption: caption && containsPoint(caption, x, y) ? caption : null,
      text
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
    if (at.text) store.selectText(at.text.id)
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
      store.setWebcam(
        {
          corner: null,
          position: {
            x: (at.x - current.grabX) / at.output.width,
            y: (at.y - current.grabY) / at.output.height
          }
        },
        'webcam-move'
      )
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
    if (current?.kind === 'text') {
      store.setTextStyle(
        current.id,
        { position: { x: (at.x - current.grabX) / at.output.width, y: (at.y - current.grabY) / at.output.height } },
        'text-move'
      )
      return
    }
    if (current?.kind === 'caption') {
      store.setCaptionStyle(
        {
          position: {
            x: (at.x - current.grabX) / at.output.width,
            y: (at.y - current.grabY) / at.output.height
          }
        },
        'caption-move'
      )
      return
    }
    const { background, selectedZoomId } = store.getState()
    event.currentTarget.style.cursor = at.text || at.caption || at.picture
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
    if (current?.kind === 'webcam' || current?.kind === 'caption' || current?.kind === 'text' || current?.kind === 'crop') {
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
      store.setFocus(zoom.id, frameToSource(at.output, sourceSize, background, at.instance.camera, onFrame.x, onFrame.y))
    }
  }

  return (
    <div className="preview">
      <canvas
        ref={canvas}
        className="preview-canvas"
        data-pick-focus={state.selectedZoomId !== null}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null
          store.endGesture()
        }}
      />
      {failed && <p className="editor-message">Não foi possível reproduzir este vídeo.</p>}
    </div>
  )
}
