import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ASSISTANT_RESPONSE_SCHEMA,
  buildAssistantPrompt,
  parseAssistantResponse
} from '@engine/assistant/assistantPrompt'
import { SESSION_FILES } from '@shared/config/recording'
import type { AiChoice } from '@shared/models/ai'
import type { AssistantReply, AssistantRequest } from '@shared/models/assistant'
import { parseTranscript } from '@shared/models/captions'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import type { AiCliService } from './AiCliService'

/**
 * The editing assistant: one message at a time to the AI tool in use, with
 * the transcript, the state of the edit and the conversation. The answer is
 * a reply for the user and the edits to make, already checked and on the
 * recording's clock; the editor applies them.
 */
export class AssistantService {
  constructor(
    private readonly ai: AiCliService,
    private readonly sessions: SessionStore,
    private readonly logger: Logger
  ) {}

  async ask(sessionId: string, request: AssistantRequest, choice: AiChoice): Promise<AssistantReply> {
    const transcript = await this.readTranscript(sessionId)
    const words = transcript?.words ?? []
    const startedAt = Date.now()
    const { system, prompt, wordCount } = buildAssistantPrompt(request, words, transcript?.locale ?? null)
    const answer = await this.ai.ask(choice, { system, prompt, schema: ASSISTANT_RESPONSE_SCHEMA })
    const reply = parseAssistantResponse(answer, words.slice(0, wordCount), request.edit.durationMs)
    this.logger.info('assistant replied', {
      sessionId,
      provider: choice.provider,
      model: choice.model || 'default',
      effort: choice.effort,
      words: wordCount,
      actions: reply.actions.map((action) => action.type),
      elapsedMs: Date.now() - startedAt
    })
    return reply
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
