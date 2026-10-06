import { describe, expect, it } from 'vitest'
import { speechSimilarity } from './dubVerification'

describe('speechSimilarity', () => {
  it('is 1 when everything was heard, whatever the punctuation, case or accents', () => {
    expect(speechSimilarity('Hola a todos. Hoy exportamos un vídeo.', 'hola a todos, hoy exportamos un video')).toBe(1)
    expect(speechSimilarity('首先，点击导出按钮。', '首先点击导出按钮')).toBe(1)
  })

  it('is 0 when nothing was heard', () => {
    expect(speechSimilarity('Hello everyone', '')).toBe(0)
  })

  it('drops with what was not heard', () => {
    // The first two characters were lost: six of eight remain.
    expect(speechSimilarity('首先点击导出按钮', '点击导出按钮')).toBeCloseTo(0.75)
    expect(speechSimilarity('然后选择你想要的速度', '不想要的速度')).toBeCloseTo(0.5)
  })

  it('forgives a homophone as one wrong character, not a wrong sentence', () => {
    expect(speechSimilarity('可以在文件夹里找到它', '可以在文件夹里找到他')).toBeCloseTo(0.9)
  })

  it('does not reward extra words', () => {
    expect(speechSimilarity('click export', 'please click the export button now')).toBe(1)
    expect(speechSimilarity('click the export button now', 'click export')).toBeLessThan(0.6)
  })

  it('treats empty expected text as satisfied', () => {
    expect(speechSimilarity('…', 'anything')).toBe(1)
  })
})
