import { describe, expect, it } from 'vitest'
import type { DisplaySource, WindowSource } from './capture'
import { sourceLabel, uniqueDisplayNames } from './capture'

const display: DisplaySource = {
  kind: 'display',
  id: 'display:2',
  displayId: 2,
  index: 2,
  name: 'LG UltraWide',
  isMain: false,
  widthPx: 3440,
  heightPx: 1440,
  scaleFactor: 1,
  thumbnailDataUrl: null
}

describe('sourceLabel', () => {
  it('calls a display by the name the system gives the monitor', () => {
    expect(sourceLabel(display)).toBe('LG UltraWide')
  })

  it('falls back to its position when the system gives no name', () => {
    expect(sourceLabel({ ...display, name: '  ' })).toBe('Tela 2')
  })

  it('calls a window by its application and title', () => {
    const window: WindowSource = {
      kind: 'window',
      id: 'window:9',
      windowId: 9,
      title: 'Caixa de entrada',
      appName: 'Mail',
      bundleId: 'com.apple.mail',
      displayId: 2,
      widthPx: 1200,
      heightPx: 800,
      thumbnailDataUrl: null
    }
    expect(sourceLabel(window)).toBe('Mail — Caixa de entrada')
  })
})

describe('uniqueDisplayNames', () => {
  it('leaves different names alone', () => {
    expect(uniqueDisplayNames(['Tela integrada', 'LG UltraWide'])).toEqual(['Tela integrada', 'LG UltraWide'])
  })

  it('numbers monitors of the same model', () => {
    expect(uniqueDisplayNames(['DELL U2720Q', 'Tela integrada', 'DELL U2720Q', 'DELL U2720Q'])).toEqual([
      'DELL U2720Q',
      'Tela integrada',
      'DELL U2720Q (2)',
      'DELL U2720Q (3)'
    ])
  })
})
