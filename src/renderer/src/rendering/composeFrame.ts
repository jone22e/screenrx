import { CAPTION_LAYOUT } from '@engine/captions/captionConfig'
import { captionFontCss, captionFontPx, layoutCaption } from '@engine/captions/captionLayout'
import { findBackgroundPreset } from '@engine/rendering/backgrounds'
import type { Rect, Size } from '@engine/rendering/frameLayout'
import type { NormalizedRect } from '@engine/rendering/frameLayout'
import { centeredSquare, layoutFrame, layoutWebcam, sourceCrop } from '@engine/rendering/frameLayout'
import type { Camera } from '@engine/zoom/zoomCamera'
import { viewToSource, visibleRect } from '@engine/zoom/zoomCamera'
import type { BackgroundSettings, CaptionStyle, WebcamSettings } from '@shared/models/project'

export interface FrameInput {
  screen: CanvasImageSource
  screenSize: Size
  /** The webcam's current frame and how to show it, when the session has one and it is visible. */
  webcam: { image: CanvasImageSource; size: Size; settings: WebcamSettings } | null
  camera: Camera
  background: BackgroundSettings
  /** The caption on screen at this instant, when there is one and captions are shown. */
  caption: { text: string; style: CaptionStyle } | null
  /** The user's texts on screen at this instant, drawn over the caption in this order. */
  texts: ReadonlyArray<{ id: string; text: string; style: CaptionStyle }>
}

/** Where things ended up on the frame, for pointer interaction in the preview. */
export interface FrameRegions {
  /** The caption's block in output pixels, or `null` when none was drawn. */
  caption: Rect | null
  /** Each text's block in output pixels, in drawing order. */
  texts: Array<{ id: string; box: Rect }>
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** `#rrggbb` with an opacity, as a canvas colour. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

/** Draws a caption over the finished frame and returns the block it occupies. */
function drawCaption(context: Context, output: Size, text: string, style: CaptionStyle): Rect | null {
  context.save()
  context.font = captionFontCss(style, captionFontPx(style, output))
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const layout = layoutCaption(text, style, output, (candidate) => context.measureText(candidate).width)
  if (!layout) {
    context.restore()
    return null
  }
  const { box, fontPx } = layout

  if (style.backdrop === 'box') {
    context.fillStyle = withAlpha(style.backdropColor, CAPTION_LAYOUT.boxOpacity)
    context.beginPath()
    context.roundRect(box.x, box.y, box.width, box.height, layout.boxRadius)
    context.fill()
  }
  if (style.backdrop === 'outline') {
    context.lineJoin = 'round'
    context.lineWidth = fontPx * CAPTION_LAYOUT.outlineWidth
    context.strokeStyle = style.backdropColor
    for (const line of layout.lines) context.strokeText(line.text, line.centerX, line.centerY)
  }
  if (style.backdrop === 'shadow') {
    context.shadowColor = 'rgba(0, 0, 0, 0.8)'
    context.shadowBlur = fontPx * CAPTION_LAYOUT.shadowBlur
    context.shadowOffsetY = fontPx * CAPTION_LAYOUT.shadowOffsetY
  }
  context.fillStyle = style.color
  for (const line of layout.lines) context.fillText(line.text, line.centerX, line.centerY)
  context.restore()
  return box
}

/**
 * Draws one finished frame: backdrop, the recording (zoomed by `camera`)
 * inside its rounded frame, the webcam and the caption on top. Every pixel
 * the user sees comes from here, and the export draws with the same
 * function, so the exported video cannot differ from the preview.
 *
 *   source frame → zoom → backdrop and frame → webcam → caption
 */
export function composeFrame(context: Context, output: Size, input: FrameInput): FrameRegions {
  const preset = findBackgroundPreset(input.background.presetId)
  const layout = layoutFrame(output, input.screenSize, input.background, preset !== null)
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

  // The part of the recording in use, seen through the zoom camera.
  const crop = sourceCrop(output, input.screenSize, input.background)
  const view = visibleRect(cameraWithin(input.camera, crop))
  context.save()
  framePath()
  context.clip()
  context.drawImage(
    input.screen,
    (crop.x + view.x * crop.width) * input.screenSize.width,
    (crop.y + view.y * crop.height) * input.screenSize.height,
    view.width * crop.width * input.screenSize.width,
    view.height * crop.height * input.screenSize.height,
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

  // Captions are not part of the recording: they stay put and sharp while it zooms.
  const caption = input.caption ? drawCaption(context, output, input.caption.text, input.caption.style) : null
  const texts: FrameRegions['texts'] = []
  for (const item of input.texts) {
    const box = drawCaption(context, output, item.text, item.style)
    if (box) texts.push({ id: item.id, box })
  }
  return { caption, texts }
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/**
 * The zoom camera, whose centre is on the whole recording, as seen from the
 * part of it in use: the same view relative to that part, kept inside it.
 * With the whole recording in use this is the camera itself.
 */
export function cameraWithin(camera: Camera, crop: NormalizedRect): Camera {
  if (crop.width === 1 && crop.height === 1) return camera
  const half = 1 / camera.scale / 2
  return {
    scale: camera.scale,
    centerX: clamp((camera.centerX - crop.x) / crop.width, half, 1 - half),
    centerY: clamp((camera.centerY - crop.y) / crop.height, half, 1 - half)
  }
}

/** Maps a point of the picture on screen (0…1 of the frame) to the whole recording's coordinates. */
export function frameToSource(
  output: Size,
  source: Size,
  background: BackgroundSettings,
  camera: Camera,
  frameX: number,
  frameY: number
): { x: number; y: number } {
  const crop = sourceCrop(output, source, background)
  const within = viewToSource(cameraWithin(camera, crop), frameX, frameY)
  return { x: crop.x + within.x * crop.width, y: crop.y + within.y * crop.height }
}

/**
 * Maps a point of the output (0…1) to the picture on screen (0…1 of the
 * frame), or `null` when it falls on the backdrop rather than on the recording.
 */
export function outputToFrame(
  output: Size,
  source: Size,
  background: BackgroundSettings,
  outputX: number,
  outputY: number
): { x: number; y: number } | null {
  const framed = findBackgroundPreset(background.presetId) !== null
  const { frame } = layoutFrame(output, source, background, framed)
  const x = (outputX * output.width - frame.x) / frame.width
  const y = (outputY * output.height - frame.y) / frame.height
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
