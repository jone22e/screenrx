import { buildEpisodePrompt, parseEpisodeResponse } from '@engine/ai/episodePrompt'
import type { AiChoice } from '@shared/models/ai'
import { appError } from '@shared/models/errors'
import type { SeriesPlan } from '@shared/models/series'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { AiError } from './AiCliService'
import type { AiCliService } from './AiCliService'

/**
 * Asks the AI how to split a recording into the episodes of a series. Only
 * the transcript's text goes to the tool; the answer is a plan the user
 * reviews before anything is cut.
 */
export class EpisodePlannerService {
  constructor(
    private readonly ai: AiCliService,
    private readonly sessions: SessionStore,
    private readonly logger: Logger
  ) {}

  async plan(sessionId: string, choice: AiChoice, targetSec: number): Promise<SeriesPlan> {
    const manifest = await this.sessions.read(sessionId)
    const durationMs = manifest?.assets.screen?.durationMs
    const transcript = await this.sessions.readTranscript(sessionId)
    if (!manifest || durationMs === undefined || !transcript || transcript.words.length === 0) throw new AiError(appError('ai-no-transcript'))
    const startedAt = Date.now()
    const { system, prompt, schema, wordCount } = buildEpisodePrompt(transcript.words, transcript.locale, targetSec)
    const answer = await this.ai.ask(choice, { system, prompt, schema })
    const plan = parseEpisodeResponse(answer, transcript.words.slice(0, wordCount), durationMs, manifest.title ?? manifest.source.label)
    if (!plan) throw new AiError(appError('ai-failed', 'no usable episodes in the answer'))
    this.logger.info('episodes planned', { sessionId, provider: choice.provider, words: wordCount, episodes: plan.episodes.length, elapsedMs: Date.now() - startedAt })
    return plan
  }
}

