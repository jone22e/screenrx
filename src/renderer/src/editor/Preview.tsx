import type { PointerEvent } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { containsPoint, layoutWebcam } from '@engine/rendering/frameLayout'
import { viewToSource } from '@engine/zoom/zoomCamera'
import type { EditorSession } from '@shared/models/editor'
import { outputToFrame } from '../rendering/composeFrame'
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
  | { kind: 'picture' }

const settingsOf = (state: EditorState): PreviewSettings => ({
  timeMap: state.timeMap,
  zooms: state.zooms,
  background: state.background,
  webcam: state.webcam,
  captions: state.captions,
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
    return {
      instance,
      output,
      x,
      y,
      picture: picture && containsPoint(picture, x, y) ? picture : null,
      caption: caption && containsPoint(caption, x, y) ? caption : null
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    const at = locate(event)
    if (!at) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // The caption is drawn over everything else, so it is what a press on it grabs.
    const grabbed = at.caption ?? at.picture
    press.current = grabbed
      ? {
          kind: at.caption ? 'caption' : 'webcam',
          grabX: at.x - (grabbed.x + grabbed.width / 2),
          grabY: at.y - (grabbed.y + grabbed.height / 2)
        }
      : { kind: 'picture' }
  }

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
    event.currentTarget.style.cursor = at.caption || at.picture
      ? 'grab'
      : store.getState().selectedZoomId !== null
        ? 'crosshair'
        : 'default'
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const current = press.current
    press.current = null
    if (current?.kind === 'webcam' || current?.kind === 'caption') {
      store.endGesture()
      return
    }
    // With a zoom selected, a click on the recording moves its focus to that point.
    const at = locate(event)
    const zoom = store.selectedZoom
    if (!current || !at || !zoom) return
    const onFrame = outputToFrame(at.output, store.getState().background, at.x / at.output.width, at.y / at.output.height)
    if (onFrame) store.setFocus(zoom.id, viewToSource(at.instance.camera, onFrame.x, onFrame.y))
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
