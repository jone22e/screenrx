import type { TranslatableCue } from '@engine/captions/captionTranslation'
import {
  TRANSLATION_RESPONSE_SCHEMA,
  buildTranslationPrompt,
  parseTranslationResponse,
  translationBatches
} from '@engine/captions/captionTranslation'
import type { AiChoice } from '@shared/models/ai'
import type { CaptionLanguage } from '@shared/models/project'
import type { Logger } from '../logging/logger'
import type { AiCliService } from './AiCliService'

/**
 * Translates captions with the AI tool the user chose. Only the captions'
 * text is sent. A long list goes in several requests, one after the other;
 * a caption the model leaves out simply has no translation.
 */
export class CaptionTranslationService {
  constructor(
    private readonly ai: AiCliService,
    private readonly logger: Logger
  ) {}

  /** Returns the translated text of each caption, by caption id. */
  async translate(
    cues: readonly TranslatableCue[],
    sourceLocale: string,
    language: CaptionLanguage,
    choice: AiChoice
  ): Promise<Record<string, string>> {
    const startedAt = Date.now()
    const translated: Record<string, string> = {}
    for (const batch of translationBatches(cues)) {
      const { system, prompt } = buildTranslationPrompt(batch, sourceLocale, language)
      const answer = await this.ai.ask(choice, { system, prompt, schema: TRANSLATION_RESPONSE_SCHEMA })
      Object.assign(translated, parseTranslationResponse(answer, batch))
    }
    this.logger.info('captions translated', {
      provider: choice.provider,
      model: choice.model || 'default',
      language,
      captions: cues.length,
      translated: Object.keys(translated).length,
      elapsedMs: Date.now() - startedAt
    })
    return translated
  }
}
