import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AiChoice, AiProviderId } from '@shared/models/ai'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { Logger } from '../logging/logger'
import { AI_PROVIDER_SPECS, toolEffort } from './aiCatalog'
import type { ToolResult } from './cliProcess'
import { lastLine, locateBinary, runTool, toolEnv } from './cliProcess'

export class AiError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'AiError'
  }
}

/** One question to an AI: instructions, the material, and the shape the answer must have. */
export interface AiRequest {
  system: string
  prompt: string
  /** JSON Schema of the answer. */
  schema: object
}

export interface AiCliServiceOptions {
  logger: Logger
  /** Directories searched for the command-line tools, in order. */
  searchDirs: string[]
  /** Environment the tools are started from. */
  env: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** Generous: the highest effort levels think for minutes. */
const DEFAULT_TIMEOUT_MS = 300_000

/** A JSON value from a model's text: the text itself, or the outermost object inside it. */
function extractJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('the answer is not JSON')
    return JSON.parse(text.slice(start, end + 1))
  }
}

/**
 * The only code that asks an AI anything. It drives the command-line tools
 * the user already has installed and signed in to (Claude Code, Codex,
 * Antigravity), one question at a time, so the app holds no API key of its own.
 *
 * The tools are given nothing to act with: no tools, a read-only sandbox or
 * plan mode, an empty working directory. They receive text and return JSON,
 * which the caller validates.
 */
export class AiCliService {
  private running: AbortController | null = null

  constructor(private readonly options: AiCliServiceOptions) {}

  get busy(): boolean {
    return this.running !== null
  }

  /** Asks one question, with the chosen tool, model and effort, and returns the parsed JSON answer. */
  async ask(choice: AiChoice, request: AiRequest): Promise<unknown> {
    if (this.running) throw new AiError(appError('ai-busy'))
    const spec = AI_PROVIDER_SPECS[choice.provider]
    const binary = await locateBinary(this.options.searchDirs, spec.binary)
    if (!binary) throw new AiError(appError('ai-unavailable', `${spec.binary} not found`))

    const controller = new AbortController()
    this.running = controller
    // An empty directory of its own: the tool has no project to read or change.
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'screenrx-ai-'))
    try {
      const ask = { claude: this.askClaude, codex: this.askCodex, agy: this.askAgy }[choice.provider]
      return await ask.call(this, binary, workDir, choice, request, controller.signal)
    } finally {
      this.running = null
      await rm(workDir, { recursive: true, force: true })
    }
  }

  /** Stops the question in progress, if any. */
  cancel(): void {
    this.running?.abort()
  }

  private async askClaude(
    binary: string,
    workDir: string,
    choice: AiChoice,
    request: AiRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const args = [
      '--print',
      '--output-format', 'json',
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--effort', toolEffort('claude', choice.effort),
      '--system-prompt', request.system,
      '--json-schema', JSON.stringify(request.schema)
    ]
    if (choice.model) args.push('--model', choice.model)
    const result = await this.run('claude', binary, args, workDir, request.prompt, signal)
    const reply = extractJson(result.stdout) as { is_error?: unknown; result?: unknown; structured_output?: unknown }
    if (reply.is_error === true) {
      throw new AiError(appError('ai-failed', `claude: ${String(reply.result).slice(0, 500)}`))
    }
    if (reply.structured_output !== undefined && reply.structured_output !== null) return reply.structured_output
    return extractJson(String(reply.result ?? ''))
  }

  private async askCodex(
    binary: string,
    workDir: string,
    choice: AiChoice,
    request: AiRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const schemaPath = path.join(workDir, 'schema.json')
    const answerPath = path.join(workDir, 'answer.json')
    await writeFile(schemaPath, JSON.stringify(request.schema))
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      '--output-schema', schemaPath,
      '--output-last-message', answerPath,
      '--cd', workDir,
      '-c', `model_reasoning_effort="${toolEffort('codex', choice.effort)}"`
    ]
    if (choice.model) args.push('--model', choice.model)
    args.push('-')
    await this.run('codex', binary, args, workDir, `${request.system}\n\n${request.prompt}`, signal)
    return extractJson(await readFile(answerPath, 'utf8'))
  }

  private async askAgy(
    binary: string,
    workDir: string,
    choice: AiChoice,
    request: AiRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const schemaPath = path.join(workDir, 'schema.json')
    await writeFile(schemaPath, JSON.stringify(request.schema))
    // Plan mode only reads. This tool takes its prompt as an argument, not on stdin.
    const args = [
      '--output-format', 'json',
      '--mode', 'plan',
      '--effort', toolEffort('agy', choice.effort),
      `--json-schema=${schemaPath}`,
      `--print=${request.system}\n\n${request.prompt}`
    ]
    if (choice.model) args.push('--model', choice.model)
    const result = await this.run('agy', binary, args, workDir, '', signal)
    const reply = extractJson(result.stdout) as {
      status?: unknown
      response?: unknown
      structured_output?: unknown
      error?: unknown
    }
    if (typeof reply.status === 'string' && !/success/i.test(reply.status)) {
      throw new AiError(appError('ai-failed', `agy: ${String(reply.error ?? reply.status).slice(0, 500)}`))
    }
    if (reply.structured_output !== undefined && reply.structured_output !== null) return reply.structured_output
    return extractJson(String(reply.response ?? ''))
  }

  /** Runs a tool to the end and returns what it printed; anything but a clean exit is a failure. */
  private async run(
    provider: AiProviderId,
    binary: string,
    args: string[],
    cwd: string,
    input: string,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const { logger, searchDirs, env, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    let result: ToolResult
    try {
      result = await runTool(binary, args, { cwd, env: toolEnv(env, searchDirs), input, timeoutMs, signal })
    } catch (error) {
      logger.error('AI tool could not start', { provider, error: String(error) })
      throw new AiError(appError('ai-unavailable', String(error)))
    }
    if (result.aborted) throw new AiError(appError('ai-cancelled'))
    if (result.timedOut) throw new AiError(appError('ai-failed', `${provider}: no answer after ${timeoutMs} ms`))
    if (result.code !== 0) {
      throw new AiError(appError('ai-failed', `${provider} exit ${result.code}: ${lastLine(result).slice(0, 500)}`))
    }
    return result
  }
}
