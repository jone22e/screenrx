import { describe, expect, it } from 'vitest'
import { canvasColorFilter, detectionFilters, escapeFilterPath, planRender } from './filterChain'

const off = { enabled: false as const, strength: 'medium' as const }

describe('planRender', () => {
  it('chains stabilization, noise reduction and sharpening in that order, ending in 4:2:0', () => {
    const plan = planRender({
      stabilization: { enabled: true, strength: 'strong' },
      denoise: { enabled: true, strength: 'light' },
      sharpen: { enabled: true, strength: 'medium' }
    })
    expect(plan.detect).toBe(true)
    expect(plan.filters('/tmp/a.trf')).toBe(
      "vidstabtransform=input='/tmp/a.trf':smoothing=60:zoom=0:optzoom=1:interpol=bicubic,hqdn3d=2:1.5:3:2.25,unsharp=5:5:1:5:5:0,format=yuv420p"
    )
  })

  it('needs no detection pass without stabilization', () => {
    const plan = planRender({ stabilization: off, denoise: off, sharpen: { enabled: true, strength: 'strong' } })
    expect(plan.detect).toBe(false)
    expect(plan.filters(null)).toBe('unsharp=5:5:1.6:5:5:0,format=yuv420p')
  })

  it('refuses to stabilize without the transforms', () => {
    const plan = planRender({ stabilization: { enabled: true, strength: 'light' }, denoise: off, sharpen: off })
    expect(() => plan.filters(null)).toThrow(/transforms/)
  })
})

describe('detectionFilters and escapeFilterPath', () => {
  it('quotes the path and escapes what a filter graph would otherwise read', () => {
    expect(detectionFilters('/Users/x/Movies/ScreenRx/s/fx.trf')).toBe(
      "vidstabdetect=shakiness=5:accuracy=15:result='/Users/x/Movies/ScreenRx/s/fx.trf'"
    )
    expect(escapeFilterPath("C:/it's")).toBe("'C\\:/it\\'s'")
  })
})

describe('canvasColorFilter', () => {
  it('names only what changed, and nothing for the colour as recorded', () => {
    expect(canvasColorFilter({ brightness: 1, contrast: 1, saturation: 1 })).toBe('')
    expect(canvasColorFilter({ brightness: 1.2, contrast: 0.9, saturation: 0 })).toBe('brightness(1.2) contrast(0.9) saturate(0)')
  })
})
