import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CUT_RESPONSE_SCHEMA, buildCutPrompt, parseCutResponse } from '@engine/suggestions/cutSuggestions'
import type { TranscriptWord } from '@shared/models/captions'
import type { Logger } from '../logging/logger'
import type { AiChoice, AiProviderId } from '@shared/models/ai'
import { AiCliService, AiError } from './AiCliService'
import { defaultAiSearchDirs } from './cliProcess'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
const request = { system: 'Be brief.', prompt: 'Transcript:\n0 Olá', schema: { type: 'object' } }

let directory: string

const choose = (provider: AiProviderId, model = '', effort: AiChoice['effort'] = 'medium'): AiChoice => ({
  provider,
  model,
  effort
})

/** Installs a stand-in for a command-line tool: a shell script with this body. */
async function install(name: 'claude' | 'codex' | 'agy', body: string): Promise<void> {
  const file = path.join(directory, name)
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
}

const createService = (timeoutMs?: number): AiCliService =>
  new AiCliService({
    logger,
    searchDirs: [directory],
    env: { PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer', HOME: os.homedir() },
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  })

const errorCodeOf = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation
  } catch (error) {
    if (error instanceof AiError) return error.appError.code
    throw error
  }
  return 'no error'
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'screenrx-ai-test-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('AiCliService', () => {
  it('asks Claude without tools and returns its structured answer', async () => {
    // The stand-in records how it was called, then answers like `claude --output-format json`.
    await install(
      'claude',
      [
        `printf '%s\\n' "$@" > "${'${0}'}.args"`,
        `cat > "${'${0}'}.stdin"`,
        `env > "${'${0}'}.env"`,
        `pwd > "${'${0}'}.cwd"`,
        `echo '{"type":"result","is_error":false,"result":"ok","structured_output":{"cuts":[{"fromWord":0,"toWord":0}]}}'`
      ].join('\n')
    )
    const answer = await createService().ask(choose('claude', 'haiku', 'ultra'), request)
    expect(answer).toEqual({ cuts: [{ fromWord: 0, toWord: 0 }] })

    const recorded = (suffix: string): Promise<string> => readFile(path.join(directory, `claude.${suffix}`), 'utf8')
    const args = (await recorded('args')).split('\n')
    expect(args).toEqual(expect.arrayContaining(['--print', '--strict-mcp-config', '--no-session-persistence']))
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    // The chosen model, and the effort mapped to the nearest level this tool has.
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Be brief.')
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1] ?? '')).toEqual({ type: 'object' })
    expect(await recorded('stdin')).toBe(request.prompt)
    // Not as a nested Claude Code session, and not inside any project.
    expect(await recorded('env')).not.toMatch(/^CLAUDE/m)
    expect(await recorded('cwd')).not.toContain('screenrx-ai-test-')
  })

  it('reads the answer from the text when Claude returns no structured output', async () => {
    await install('claude', `cat > /dev/null; echo '{"is_error":false,"result":"Here it is: {\\"cuts\\":[]} Done."}'`)
    expect(await createService().ask(choose('claude'), request)).toEqual({ cuts: [] })
  })

  it('fails when Claude reports an error or answers with something that is not JSON', async () => {
    await install('claude', `cat > /dev/null; echo '{"is_error":true,"result":"Not logged in"}'`)
    expect(await errorCodeOf(createService().ask(choose('claude'), request))).toBe('ai-failed')
    await install('claude', `cat > /dev/null; echo 'hello'`)
    await expect(createService().ask(choose('claude'), request)).rejects.toThrow()
  })

  it('asks Codex in a read-only sandbox and reads the answer it writes', async () => {
    // Like `codex exec`: the answer goes to the file named after --output-last-message.
    await install(
      'codex',
      [
        `printf '%s\\n' "$@" > "${'${0}'}.args"`,
        `cat > "${'${0}'}.stdin"`,
        'while [ $# -gt 0 ]; do',
        '  if [ "$1" = "--output-last-message" ]; then out="$2"; fi',
        '  if [ "$1" = "--output-schema" ]; then cp "$2" "$0.schema"; fi',
        '  shift',
        'done',
        `echo '{"cuts":[]}' > "$out"`
      ].join('\n')
    )
    expect(await createService().ask(choose('codex', 'gpt-6-luna', 'high'), request)).toEqual({ cuts: [] })

    const args = (await readFile(path.join(directory, 'codex.args'), 'utf8')).split('\n')
    expect(args[0]).toBe('exec')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-6-luna')
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check']))
    expect(await readFile(path.join(directory, 'codex.stdin'), 'utf8')).toBe('Be brief.\n\nTranscript:\n0 Olá')
    expect(JSON.parse(await readFile(path.join(directory, 'codex.schema'), 'utf8'))).toEqual({ type: 'object' })
  })

  it('leaves the model to the account when none is chosen', async () => {
    await install('claude', `printf '%s\\n' "$@" > "${'${0}'}.args"; cat > /dev/null; echo '{"is_error":false,"structured_output":{}}'`)
    await createService().ask(choose('claude', ''), request)
    expect((await readFile(path.join(directory, 'claude.args'), 'utf8')).split('\n')).not.toContain('--model')
  })

  it('asks Antigravity in plan mode, with the prompt as an argument', async () => {
    // Like `agy --output-format json`: the schema is a file, the answer comes on stdout.
    await install(
      'agy',
      [
        `printf '%s\\n' "$@" > "${'${0}'}.args"`,
        'for arg in "$@"; do case "$arg" in --json-schema=*) cp "${arg#--json-schema=}" "$0.schema";; esac; done',
        `echo '{"status":"SUCCESS","response":"ok","structured_output":{"cuts":[]}}'`
      ].join('\n')
    )
    expect(await createService().ask(choose('agy', 'gemini-3.8-flash-high', 'xhigh'), request)).toEqual({ cuts: [] })

    const args = await readFile(path.join(directory, 'agy.args'), 'utf8')
    expect(args).toContain('--mode\nplan')
    expect(args).toContain('--effort\nmax')
    expect(args).toContain('--model\ngemini-3.8-flash-high')
    expect(args).toContain('--print=Be brief.\n\nTranscript:\n0 Olá')
    expect(JSON.parse(await readFile(path.join(directory, 'agy.schema'), 'utf8'))).toEqual({ type: 'object' })
  })

  it('fails when Antigravity reports a status other than success', async () => {
    await install('agy', `echo '{"status":"ERROR","error":"quota"}'`)
    expect(await errorCodeOf(createService().ask(choose('agy'), request))).toBe('ai-failed')
  })

  it('is unavailable when the tool is not installed', async () => {
    expect(await errorCodeOf(createService().ask(choose('claude'), request))).toBe('ai-unavailable')
  })

  it('fails when the tool exits with an error or takes too long', async () => {
    await install('claude', 'cat > /dev/null; echo "boom" >&2; exit 2')
    expect(await errorCodeOf(createService().ask(choose('claude'), request))).toBe('ai-failed')
    await install('claude', 'exec sleep 30')
    expect(await errorCodeOf(createService(200).ask(choose('claude'), request))).toBe('ai-failed')
  })

  it('can be cancelled, and answers one question at a time', async () => {
    await install('claude', 'exec sleep 30')
    const service = createService()
    const first = errorCodeOf(service.ask(choose('claude'), request))
    await vi.waitFor(() => expect(service.busy).toBe(true))
    expect(await errorCodeOf(service.ask(choose('claude'), request))).toBe('ai-busy')
    service.cancel()
    expect(await first).toBe('ai-cancelled')
    expect(service.busy).toBe(false)
  })
})

describe('defaultAiSearchDirs', () => {
  it('searches PATH first, then the usual install locations, without repeats', () => {
    const dirs = defaultAiSearchDirs({ PATH: '/custom/bin:/opt/homebrew/bin' }, '/Users/someone')
    expect(dirs.slice(0, 2)).toEqual(['/custom/bin', '/opt/homebrew/bin'])
    expect(dirs).toContain('/Users/someone/.local/bin')
    expect(new Set(dirs).size).toBe(dirs.length)
  })
})

/**
 * The real tools, with the real accounts. Not part of the normal run: it
 * needs the three CLIs installed and signed in, and spends a little quota.
 *
 *   SCREENRX_AI_LIVE=1 npx vitest run src/main/ai
 */
describe.runIf(process.env['SCREENRX_AI_LIVE'] === '1')('AiCliService with the installed tools', () => {
  const words: TranscriptWord[] = 'Olá pessoal, hoje eu vou é hum deixa eu começar de novo. Olá pessoal, hoje vamos exportar um vídeo.'
    .split(' ')
    .map((text, index) => ({ text, startMs: index * 400, endMs: (index + 1) * 400 }))

  it.each(['claude', 'codex', 'agy'] as const)('%s finds the abandoned first take', async (provider) => {
    const service = new AiCliService({
      logger,
      searchDirs: defaultAiSearchDirs(process.env, os.homedir()),
      env: process.env
    })
    const { system, prompt } = buildCutPrompt(words, 'pt-BR')
    const model = provider === 'claude' ? 'haiku' : ''
    const answer = await service.ask(choose(provider, model, 'low'), { system, prompt, schema: CUT_RESPONSE_SCHEMA })
    const suggestions = parseCutResponse(answer, words, words.length * 400, () => 'id')
    expect(suggestions.length).toBeGreaterThan(0)
    // The retake ("Olá pessoal, hoje vamos exportar um vídeo.", from word 12) is kept whole.
    expect(suggestions.every((cut) => cut.endMs <= 12 * 400)).toBe(true)
    expect(suggestions.some((cut) => cut.startMs === 0)).toBe(true)
  }, 180_000)
})
