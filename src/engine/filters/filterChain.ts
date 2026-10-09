import type { ColorSettings, FilterRenderRequest, FilterStrength } from '@shared/models/filters'

/**
 * How the rendered effects are asked of FFmpeg, and how the colour is asked
 * of the canvas. The same numbers serve the preview and the export: the
 * preview reads the track FFmpeg rendered, and the colour string below is
 * applied to both canvases.
 */

/** vid.stab: how far back and forth the camera path is averaged, in frames; more is steadier and crops more. */
const STABILIZATION_SMOOTHING: Record<FilterStrength, number> = { light: 10, medium: 30, strong: 60 }
/** hqdn3d: luma spatial, chroma spatial, luma temporal, chroma temporal. */
const DENOISE_PARAMETERS: Record<FilterStrength, string> = {
  light: '2:1.5:3:2.25',
  medium: '4:3:6:4.5',
  strong: '8:6:12:9'
}
/** unsharp: 5×5 luma matrix with this amount. */
const SHARPEN_AMOUNT: Record<FilterStrength, number> = { light: 0.5, medium: 1, strong: 1.6 }

/** Shakiness told to the detection pass: 1 (steady tripod) … 10 (very shaky). */
export const STABILIZATION_DETECT_SHAKINESS = 5

export interface RenderPlan {
  /** Whether a detection pass (vid.stab's first) has to run before the transform. */
  detect: boolean
  /** The filter graph of the rendering pass, given where the detection wrote its transforms. */
  filters: (transformsPath: string | null) => string
}

/**
 * The FFmpeg filter graph for a request. Stabilization comes first, so the
 * other effects see the steadied picture; sharpening last, so it does not
 * sharpen noise the denoiser then removes.
 */
export function planRender(request: FilterRenderRequest): RenderPlan {
  const stabilize = request.stabilization.enabled
  return {
    detect: stabilize,
    filters: (transformsPath) => {
      const chain: string[] = []
      if (stabilize) {
        if (!transformsPath) throw new Error('stabilization needs the transforms of the detection pass')
        chain.push(
          `vidstabtransform=input=${escapeFilterPath(transformsPath)}:smoothing=${STABILIZATION_SMOOTHING[request.stabilization.strength]}:zoom=0:optzoom=1:interpol=bicubic`
        )
      }
      if (request.denoise.enabled) chain.push(`hqdn3d=${DENOISE_PARAMETERS[request.denoise.strength]}`)
      if (request.sharpen.enabled) chain.push(`unsharp=5:5:${SHARPEN_AMOUNT[request.sharpen.strength]}:5:5:0`)
      // What the encoder reads: 4:2:0, whatever the filters produced.
      chain.push('format=yuv420p')
      return chain.join(',')
    }
  }
}

/** The filter graph of vid.stab's detection pass, writing the camera motion to `transformsPath`. */
export function detectionFilters(transformsPath: string): string {
  return `vidstabdetect=shakiness=${STABILIZATION_DETECT_SHAKINESS}:accuracy=15:result=${escapeFilterPath(transformsPath)}`
}

/** A path inside a filter graph: `:` separates options and `\` escapes there, so both are escaped and the whole is quoted. */
export function escapeFilterPath(filePath: string): string {
  return `'${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')}'`
}

/** The canvas `filter` for a colour; empty when the colour is as recorded. */
export function canvasColorFilter(color: ColorSettings): string {
  const parts: string[] = []
  if (color.brightness !== 1) parts.push(`brightness(${round(color.brightness)})`)
  if (color.contrast !== 1) parts.push(`contrast(${round(color.contrast)})`)
  if (color.saturation !== 1) parts.push(`saturate(${round(color.saturation)})`)
  return parts.join(' ')
}

const round = (value: number): number => Math.round(value * 1000) / 1000
