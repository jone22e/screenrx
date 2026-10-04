import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKGROUND, DEFAULT_WEBCAM } from '@shared/models/project'
import { centeredSquare, containsPoint, layoutFrame, layoutWebcam, webcamCornerPosition } from './frameLayout'

const output = { width: 1920, height: 1080 }

describe('layoutFrame', () => {
  it('fills the output when there is no backdrop', () => {
    expect(layoutFrame(output, DEFAULT_BACKGROUND, false)).toEqual({
      frame: { x: 0, y: 0, width: 1920, height: 1080 },
      cornerRadius: 0
    })
  })

  it('insets the recording uniformly, keeping its aspect ratio and centring it', () => {
    const { frame, cornerRadius } = layoutFrame(
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
