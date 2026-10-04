import { findBackgroundPreset } from '@engine/rendering/backgrounds'
import type { Size } from '@engine/rendering/frameLayout'
import { centeredSquare, layoutFrame, layoutWebcam } from '@engine/rendering/frameLayout'
import type { Camera } from '@engine/zoom/zoomCamera'
import { visibleRect } from '@engine/zoom/zoomCamera'
import type { BackgroundSettings, WebcamSettings } from '@shared/models/project'

export interface FrameInput {
  screen: CanvasImageSource
  screenSize: Size
  /** The webcam's current frame and how to show it, when the session has one and it is visible. */
  webcam: { image: CanvasImageSource; size: Size; settings: WebcamSettings } | null
  camera: Camera
  background: BackgroundSettings
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * Draws one finished frame: backdrop, the recording (zoomed by `camera`)
 * inside its rounded frame, and the webcam on top. Every pixel the user sees
 * comes from here, and the export will draw with the same function, so the
 * exported video cannot differ from the preview.
 *
 *   source frame → zoom → backdrop and frame → webcam
 */
export function composeFrame(context: Context, output: Size, input: FrameInput): void {
  const preset = findBackgroundPreset(input.background.presetId)
  const layout = layoutFrame(output, input.background, preset !== null)
  const { frame, cornerRadius } = layout

  // Backdrop.
  if (preset) {
    const angle = (preset.angleDeg * Math.PI) / 180
    const reach = (Math.abs(Math.cos(angle)) * output.width + Math.abs(Math.sin(angle)) * output.height) / 2
    const centerX = output.width / 2
    const centerY = output.height / 2
    const gradient = context.createLinearGradient(
      centerX - Math.cos(angle) * reach,
      centerY - Math.sin(angle) * reach,
      centerX + Math.cos(angle) * reach,
      centerY + Math.sin(angle) * reach
    )
    preset.colors.forEach((color, index) =>
      gradient.addColorStop(index / Math.max(preset.colors.length - 1, 1), color)
    )
    context.fillStyle = gradient
  } else {
    context.fillStyle = '#000'
  }
  context.fillRect(0, 0, output.width, output.height)

  const framePath = (): void => {
    context.beginPath()
    context.roundRect(frame.x, frame.y, frame.width, frame.height, cornerRadius)
  }

  // Shadow under the frame.
  if (preset && input.background.shadow) {
    const unit = Math.min(output.width, output.height)
    context.save()
    context.shadowColor = 'rgba(0, 0, 0, 0.45)'
    context.shadowBlur = unit * 0.05
    context.shadowOffsetY = unit * 0.015
    context.fillStyle = '#000'
    framePath()
    context.fill()
    context.restore()
  }

  // The recording, seen through the zoom camera.
  const view = visibleRect(input.camera)
  context.save()
  framePath()
  context.clip()
  context.drawImage(
    input.screen,
    view.x * input.screenSize.width,
    view.y * input.screenSize.height,
    view.width * input.screenSize.width,
    view.height * input.screenSize.height,
    frame.x,
    frame.y,
    frame.width,
    frame.height
  )
  context.restore()

  // Webcam: a square crop of the camera, in the chosen shape and place.
  if (input.webcam) {
    const { image, size, settings } = input.webcam
    const picture = layoutWebcam(output, settings)
    const crop = centeredSquare(size)
    const picturePath = (): void => {
      context.beginPath()
      context.roundRect(picture.x, picture.y, picture.width, picture.height, picture.cornerRadius)
    }

    context.save()
    context.shadowColor = 'rgba(0, 0, 0, 0.4)'
    context.shadowBlur = picture.width * 0.15
    context.fillStyle = '#000'
    picturePath()
    context.fill()
    context.restore()

    context.save()
    picturePath()
    context.clip()
    if (settings.mirrored) {
      // Flip around the picture's own vertical axis.
      context.translate(picture.x * 2 + picture.width, 0)
      context.scale(-1, 1)
    }
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, picture.x, picture.y, picture.width, picture.height)
    context.restore()

    if (settings.border) {
      picturePath()
      context.lineWidth = Math.max(2, picture.width * 0.015)
      context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      context.stroke()
    }
  }
}

/**
 * Maps a point of the output (0…1) to the recording's own coordinates, or
 * `null` when it falls on the backdrop rather than on the recording.
 */
export function outputToFrame(
  output: Size,
  background: BackgroundSettings,
  outputX: number,
  outputY: number
): { x: number; y: number } | null {
  const framed = findBackgroundPreset(background.presetId) !== null
  const { frame } = layoutFrame(output, background, framed)
  const x = (outputX * output.width - frame.x) / frame.width
  const y = (outputY * output.height - frame.y) / frame.height
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
