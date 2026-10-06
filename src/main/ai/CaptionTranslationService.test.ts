import { describe, expect, it, vi } from 'vitest'
import { TRANSLATION_CONFIG } from '@engine/captions/captionTranslation'
import type { AiChoice } from '@shared/models/ai'
import type { Logger } from '../logging/logger'
import type { AiCliService, AiRequest } from './AiCliService'
import { CaptionTranslationService } from './CaptionTranslationService'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
const choice: AiChoice = { provider: 'claude', model: 'sonnet', effort: 'medium' }

/** A stand-in AI that "translates" by upper-casing, and remembers what it was asked. */
function fakeAi(skip: (index: number) => boolean = () => false) {
  const requests: AiRequest[] = []
  const ai = {
    ask: (_choice: AiChoice, request: AiRequest) => {
      requests.push(request)
      const lines = request.prompt.split('Captions:\n')[1]?.split('\n') ?? []
      return Promise.resolve({
        translations: lines
          .map((line) => line.split('|'))
          .filter(([index]) => !skip(Number(index)))
          .map(([index, text]) => ({ index: Number(index), text: (text ?? '').toUpperCase() }))
      })
    }
  } as unknown as AiCliService
  return { ai, requests }
}

describe('CaptionTranslationService', () => {
  it('returns each caption translated, by its id', async () => {
    const { ai, requests } = fakeAi()
    const cues = [
      { id: 'a', text: 'olá pessoal' },
      { id: 'b', text: 'vamos exportar' }
    ]
    const translated = await new CaptionTranslationService(ai, logger).translate(cues, 'pt-BR', 'en', choice)
    expect(translated).toEqual({ a: 'OLÁ PESSOAL', b: 'VAMOS EXPORTAR' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.system).toContain('English')
  })

  it('translates a long list in several requests, each numbered from zero', async () => {
    const { ai, requests } = fakeAi()
    const cues = Array.from({ length: TRANSLATION_CONFIG.cuesPerRequest + 2 }, (_, index) => ({
      id: `cue-${index}`,
      text: `legenda ${index}`
    }))
    const translated = await new CaptionTranslationService(ai, logger).translate(cues, 'pt-BR', 'es', choice)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.prompt).toContain(`0|legenda ${TRANSLATION_CONFIG.cuesPerRequest}`)
    expect(Object.keys(translated)).toHaveLength(cues.length)
    expect(translated[`cue-${TRANSLATION_CONFIG.cuesPerRequest + 1}`]).toBe(`LEGENDA ${TRANSLATION_CONFIG.cuesPerRequest + 1}`)
  })

  it('leaves out a caption the model did not translate', async () => {
    const { ai } = fakeAi((index) => index === 1)
    const cues = [
      { id: 'a', text: 'um' },
      { id: 'b', text: 'dois' },
      { id: 'c', text: 'três' }
    ]
    const translated = await new CaptionTranslationService(ai, logger).translate(cues, 'pt-BR', 'zh', choice)
    expect(translated).toEqual({ a: 'UM', c: 'TRÊS' })
  })
})
