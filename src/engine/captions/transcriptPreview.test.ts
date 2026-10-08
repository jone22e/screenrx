import { describe, expect, it } from 'vitest'
import { suggestTitle, transcriptPreview } from './transcriptPreview'

const words = (text: string) => text.split(' ').map((word, index) => ({ text: word, startMs: index * 300, endMs: index * 300 + 200 }))

describe('transcriptPreview', () => {
  it('keeps the start of what was said, within the limit', () => {
    expect(transcriptPreview(words('oi, hoje vamos ver o pedido'))).toBe('oi, hoje vamos ver o pedido')
    const long = transcriptPreview(words(Array.from({ length: 200 }, (_, index) => `palavra${index}`).join(' ')))
    expect(long.length).toBeLessThanOrEqual(300)
    expect(long.startsWith('palavra0 palavra1')).toBe(true)
  })
})

describe('suggestTitle', () => {
  it('takes the first words, capitalized, without trailing punctuation', () => {
    expect(suggestTitle('hoje vamos configurar o relé de tempo D-5ACA, que fica')).toBe('Hoje vamos configurar o relé de')
    expect(suggestTitle('relé de tempo D-5ACA. Então o primeiro passo')).toBe('Relé de tempo D-5ACA')
  })

  it('gives up on too little', () => {
    expect(suggestTitle('')).toBe(null)
    expect(suggestTitle('oi')).toBe(null)
  })
})
