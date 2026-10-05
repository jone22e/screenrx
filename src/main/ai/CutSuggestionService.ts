import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CUT_RESPONSE_SCHEMA, buildCutPrompt, parseCutResponse } from '@engine/suggestions/cutSuggestions'
import { SESSION_FILES } from '@shared/config/recording'
import { parseTranscript } from '@shared/models/captions'
import type { AiChoice } from '@shared/models/ai'
import { appError } from '@shared/models/errors'
import type { CutSuggestionResult } from '@shared/models/suggestions'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { AiError } from './AiCliService'
import type { AiCliService } from './AiCliService'

/**
 * Clean-up cuts proposed by an AI. It reads the session's transcript — the
 * text only; audio and video never leave the machine — and answers with
 * spans of words, which become suggestions on the recording's clock. Nothing
 * is applied here: the editor shows them and the user decides.
 */
export class CutSuggestionService {
  constructor(
    private readonly ai: AiCliService,
    private readonly sessions: SessionStore,
    private readonly logger: Logger
  ) {}

  async suggest(sessionId: string, choice: AiChoice): Promise<CutSuggestionResult> {
    const manifest = await this.sessions.read(sessionId)
    const durationMs = manifest?.assets.screen?.durationMs
    const transcript = await this.readTranscript(sessionId)
    if (durationMs === undefined || !transcript || transcript.words.length === 0) {
      throw new AiError(appError('ai-no-transcript'))
    }

    const startedAt = Date.now()
    const { system, prompt, wordCount } = buildCutPrompt(transcript.words, transcript.locale)
    const answer = await this.ai.ask(choice, { system, prompt, schema: CUT_RESPONSE_SCHEMA })
    const suggestions = parseCutResponse(answer, transcript.words.slice(0, wordCount), durationMs, () =>
      `suggestion-${randomUUID()}`
    )
    this.logger.info('cut suggestions', {
      sessionId,
      provider: choice.provider,
      model: choice.model || 'default',
      effort: choice.effort,
      words: wordCount,
      suggestions: suggestions.length,
      elapsedMs: Date.now() - startedAt
    })
    return { suggestions, analyzedWords: wordCount, totalWords: transcript.words.length }
  }

  cancel(): void {
    this.ai.cancel()
  }

  private async readTranscript(sessionId: string) {
    try {
      const file = path.join(this.sessions.directoryOf(sessionId), SESSION_FILES.transcript)
      return parseTranscript(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      return null
    }
  }
}
