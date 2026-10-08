import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKGROUND, DEFAULT_WEBCAM } from '@shared/models/project'
import { centeredSquare, containsPoint, layoutFrame, layoutWebcam, outputSizeFor, sourceCrop, webcamCornerPosition } from './frameLayout'

const output = { width: 1920, height: 1080 }

describe('layoutFrame', () => {
  it('fills the output when there is no backdrop', () => {
    expect(layoutFrame(output, output, DEFAULT_BACKGROUND, false)).toEqual({
      frame: { x: 0, y: 0, width: 1920, height: 1080 },
      cornerRadius: 0
    })
  })

  it('insets the recording uniformly, keeping its aspect ratio and centring it', () => {
    const { frame, cornerRadius } = layoutFrame(
      output,
      output,
      { ...DEFAULT_BACKGROUND, paddingRatio: 0.1, cornerRadiusRatio: 0.02 },
      true
    )
    expect(frame.width / frame.height).toBeCloseTo(1920 / 1080)
    expect(frame.width).toBeCloseTo(1536)
    expect(frame.x).toBeCloseTo((1920 - 1536) / 2)
    expect(frame.y).toBeCloseTo((1080 - frame.height) / 2)
    expect(cornerRadius).toBeCloseTo(21.6)
  })

  it('fits a wide recording across a vertical output, centred, with the padding on the sides', () => {
    const vertical = { width: 1080, height: 1920 }
    const { frame } = layoutFrame(vertical, output, { ...DEFAULT_BACKGROUND, paddingRatio: 0.05 }, true)
    expect(frame.width).toBeCloseTo(972)
    expect(frame.height).toBeCloseTo(972 * (1080 / 1920))
    expect(frame.x).toBeCloseTo(54)
    expect(frame.y).toBeCloseTo((1920 - frame.height) / 2)
  })

  it('letterboxes without a backdrop when the shapes differ', () => {
    const square = { width: 1080, height: 1080 }
    const { frame, cornerRadius } = layoutFrame(square, output, DEFAULT_BACKGROUND, false)
    expect(frame).toEqual({ x: 0, y: (1080 - 607.5) / 2, width: 1080, height: 607.5 })
    expect(cornerRadius).toBe(0)
  })
})

describe('outputSizeFor', () => {
  it('keeps the recording\'s own size for the native format', () => {
    expect(outputSizeFor({ width: 3456, height: 2234 }, 'native')).toEqual({ width: 3456, height: 2234 })
  })

  it('shapes the output around the recording\'s shorter side', () => {
    expect(outputSizeFor(output, 'reels')).toEqual({ width: 1080, height: 1920 })
    expect(outputSizeFor(output, 'tiktok')).toEqual({ width: 1080, height: 1920 })
    expect(outputSizeFor({ width: 3456, height: 2234 }, 'reels')).toEqual({ width: 2234, height: 3972 })
  })
})

describe('filling a vertical frame', () => {
  const vertical = { width: 1080, height: 1920 }
  const filling = { ...DEFAULT_BACKGROUND, aspect: 'reels' as const, fit: 'fill' as const, paddingRatio: 0.05 }

  it('gives the recording the whole room', () => {
    const { frame } = layoutFrame(vertical, output, filling, true)
    expect(frame).toEqual({ x: 54, y: 96, width: 972, height: 1728 })
  })

  it('uses the tallest stretch of the recording of the frame\'s shape, centred where asked', () => {
    // A 16:9 recording in a 9:16 frame: the stretch is the full height and 9/16 ÷ 16/9 of the width.
    const crop = sourceCrop(vertical, output, filling)
    expect(crop.width).toBeCloseTo(0.31640625)
    expect(crop.height).toBe(1)
    expect(crop.x).toBeCloseTo(0.5 - 0.31640625 / 2)
    expect(crop.y).toBe(0)
    const left = sourceCrop(vertical, output, { ...filling, crop: { x: 0.3, y: 0.5 } })
    expect(left.x).toBeCloseTo(0.3 - 0.31640625 / 2)
  })

  it('keeps the part inside the recording', () => {
    const crop = sourceCrop(vertical, output, { ...filling, crop: { x: 0, y: 0.5 } })
    expect(crop.x).toBe(0)
    const right = sourceCrop(vertical, output, { ...filling, crop: { x: 1, y: 0.5 } })
    expect(right.x + right.width).toBeCloseTo(1)
  })

  it('shows all of the recording when it does not fill, or in its own format', () => {
    expect(sourceCrop(vertical, output, { ...filling, fit: 'fit' })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(sourceCrop(output, output, { ...filling, aspect: 'native' })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('layoutWebcam', () => {
  it('snaps to each corner with the same margin', () => {
    const margin = 0.04 * output.height
    const side = DEFAULT_WEBCAM.sizeRatio * output.height
    const at = (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') =>
      layoutWebcam(output, { ...DEFAULT_WEBCAM, corner })

    expect(at('top-left')).toMatchObject({ x: margin, y: margin, width: side, height: side })
    expect(at('bottom-right').x).toBeCloseTo(output.width - margin - side)
    expect(at('bottom-right').y).toBeCloseTo(output.height - margin - side)
    expect(at('top-right').y).toBeCloseTo(margin)
    expect(at('bottom-left').x).toBeCloseTo(margin)
  })

  it('follows a free position but never leaves the output', () => {
    const free = (x: number, y: number) =>
      layoutWebcam(output, { ...DEFAULT_WEBCAM, corner: null, position: { x, y } })
    const centred = free(0.5, 0.5)
    expect(centred.x + centred.width / 2).toBeCloseTo(output.width / 2)
    expect(centred.y + centred.height / 2).toBeCloseTo(output.height / 2)

    const pushedOut = free(1.4, -0.3)
    expect(pushedOut.x + pushedOut.width).toBeCloseTo(output.width)
    expect(pushedOut.y).toBe(0)
  })

  it('rounds the corners according to the shape', () => {
    const side = DEFAULT_WEBCAM.sizeRatio * output.height
    expect(layoutWebcam(output, { ...DEFAULT_WEBCAM, shape: 'circle' }).cornerRadius).toBeCloseTo(side / 2)
    expect(layoutWebcam(output, { ...DEFAULT_WEBCAM, shape: 'square' }).cornerRadius).toBe(0)
    const rounded = layoutWebcam(output, { ...DEFAULT_WEBCAM, shape: 'rounded' }).cornerRadius
    expect(rounded).toBeGreaterThan(0)
    expect(rounded).toBeLessThan(side / 2)
  })

  it('scales with the size setting', () => {
    expect(layoutWebcam(output, { ...DEFAULT_WEBCAM, sizeRatio: 0.4 }).width).toBeCloseTo(432)
  })
})

describe('webcamCornerPosition', () => {
  it('is where a free placement would have to be to match the corner', () => {
    const position = webcamCornerPosition(output, DEFAULT_WEBCAM.sizeRatio, 'top-right')
    expect(layoutWebcam(output, { ...DEFAULT_WEBCAM, corner: null, position })).toEqual(
      layoutWebcam(output, { ...DEFAULT_WEBCAM, corner: 'top-right' })
    )
  })
})

describe('containsPoint', () => {
  it('tells whether a point is over a rectangle', () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 }
    expect(containsPoint(rect, 50, 40)).toBe(true)
    expect(containsPoint(rect, 5, 40)).toBe(false)
    expect(containsPoint(rect, 50, 80)).toBe(false)
  })
})

describe('centeredSquare', () => {
  it('crops the longer side', () => {
    expect(centeredSquare({ width: 1280, height: 720 })).toEqual({ x: 280, y: 0, width: 720, height: 720 })
    expect(centeredSquare({ width: 600, height: 800 })).toEqual({ x: 0, y: 100, width: 600, height: 600 })
  })
})
