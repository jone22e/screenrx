import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../logging/logger'
import { AiError } from './AiCliService'
import { AiSetupService } from './AiSetupService'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

let home: string
let bin: string

/** Puts a stand-in for a command-line tool on the search path: a shell script with this body. */
async function install(name: string, body: string): Promise<void> {
  const file = path.join(bin, name)
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
}

/** A stand-in Claude that is signed in once the file `signed-in` exists next to it. */
const CLAUDE = [
  'case "$1" in',
  '  --version) echo "2.1.288 (Claude Code)";;',
  '  auth)',
  '    if [ "$2" = "login" ]; then touch "$(dirname "$0")/signed-in"; exec sleep 30; fi',
  '    if [ -f "$(dirname "$0")/signed-in" ]; then echo \'{"loggedIn":true,"email":"ana@example.com","subscriptionType":"max"}\'',
  '    else echo \'{"loggedIn":false}\'; fi;;',
  'esac'
].join('\n')

const createService = (installCommand?: (url: string) => { command: string; args: string[] }): AiSetupService =>
  new AiSetupService({
    logger,
    searchDirs: [bin],
    env: { PATH: '/usr/bin:/bin', HOME: home },
    home,
    loginPollMs: 50,
    loginTimeoutMs: 5000,
    ...(installCommand ? { installCommand } : {})
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
  home = await mkdtemp(path.join(os.tmpdir(), 'screenrx-ai-home-'))
  bin = path.join(home, 'bin')
  await mkdir(bin)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('AiSetupService.providers', () => {
  it('reports a tool that is not installed, with what it would offer', async () => {
    const providers = await createService().providers()
    expect(providers.map((provider) => provider.id)).toEqual(['claude', 'codex', 'agy'])
    expect(providers[0]).toMatchObject({
      label: 'Claude',
      toolName: 'Claude Code',
      installed: false,
      version: null,
      loggedIn: false,
      canLogIn: true,
      defaultEffort: 'medium'
    })
    expect(providers[0]?.models.map((model) => model.id)).toEqual(['sonnet', 'haiku', 'opus', 'fable'])
    expect(providers[2]).toMatchObject({ installed: false, canLogIn: false })
  })

  it('reads version and account from Claude', async () => {
    await install('claude', CLAUDE)
    await writeFile(path.join(bin, 'signed-in'), '')
    const [claude] = await createService().providers()
    expect(claude).toMatchObject({ installed: true, version: '2.1.288', loggedIn: true, account: 'ana@example.com · max' })
  })

  it('reads Codex status from its exit code and its models from its own catalogue', async () => {
    await install('codex', 'case "$1" in --version) echo "codex-cli 0.160.0";; login) echo "Logged in using ChatGPT";; esac')
    await mkdir(path.join(home, '.codex'))
    await writeFile(
      path.join(home, '.codex', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', priority: 1, supported_reasoning_levels: [{ effort: 'low' }] }] })
    )
    const codex = (await createService().providers())[1]
    expect(codex).toMatchObject({ installed: true, version: '0.160.0', loggedIn: true, account: 'Logged in using ChatGPT' })
    expect(codex?.models).toEqual([
      { id: '', label: 'Padrão da conta' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low'] }
    ])

    await install('codex', 'case "$1" in --version) echo "codex-cli 0.160.0";; login) echo "Not logged in"; exit 1;; esac')
    expect((await createService().providers())[1]).toMatchObject({ installed: true, loggedIn: false, account: null })
  })

  it('reads Antigravity sign-in from what it stores, and its models from the tool', async () => {
    await install('agy', 'case "$1" in --version) echo "1.2.16";; models) printf "Fetching…\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n";; esac')
    expect((await createService().providers())[2]).toMatchObject({ installed: true, version: '1.2.16', loggedIn: false })

    const claims = Buffer.from(JSON.stringify({ email: 'ana@example.com' })).toString('base64url')
    await mkdir(path.join(home, '.gemini'))
    await writeFile(path.join(home, '.gemini', 'jetski-standalone-oauth-token'), JSON.stringify({ token: {}, id_token: `x.${claims}.y` }))
    const agy = (await createService().providers())[2]
    expect(agy).toMatchObject({ loggedIn: true, account: 'ana@example.com' })
    expect(agy?.models).toEqual([
      { id: '', label: 'Padrão da conta' },
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }
    ])
  })

  it('looks once and remembers, until asked to look again', async () => {
    const service = createService()
    expect((await service.providers())[0]?.installed).toBe(false)
    await install('claude', CLAUDE)
    expect((await service.providers())[0]?.installed).toBe(false)
    expect((await service.providers(true))[0]?.installed).toBe(true)
  })
})

describe('AiSetupService.install', () => {
  it("runs the vendor's installer and reports the tool as installed", async () => {
    // The stand-in installer does what the real one does: puts the tool on the search path.
    const source = path.join(home, 'claude-download')
    await writeFile(source, `#!/bin/sh\n${CLAUDE}\n`)
    await chmod(source, 0o755)
    const urls: string[] = []
    const service = createService((url) => {
      urls.push(url)
      return { command: '/bin/sh', args: ['-c', `cp "${source}" "${path.join(bin, 'claude')}"`] }
    })
    const providers = await service.install('claude')
    expect(urls).toEqual(['https://claude.ai/install.sh'])
    expect(providers[0]).toMatchObject({ installed: true, version: '2.1.288', loggedIn: false })
  })

  it('fails with what the installer said when the tool is still missing', async () => {
    const service = createService(() => ({ command: '/bin/sh', args: ['-c', 'echo "network unreachable" >&2; exit 7'] }))
    try {
      await service.install('codex')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AiError)
      expect((error as AiError).appError).toMatchObject({ code: 'ai-install-failed', detail: 'network unreachable' })
    }
  })

  it('can be cancelled, and does one thing at a time', async () => {
    const service = createService(() => ({ command: '/bin/sh', args: ['-c', 'exec sleep 30'] }))
    const first = errorCodeOf(service.install('claude'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await errorCodeOf(service.install('codex'))).toBe('ai-busy')
    service.cancel()
    expect(await first).toBe('ai-install-failed')
  })
})

describe('AiSetupService.login', () => {
  it("starts the tool's sign-in and finishes as soon as the tool reports an account", async () => {
    await install('claude', CLAUDE)
    const service = createService()
    expect((await service.providers())[0]?.loggedIn).toBe(false)
    // The stand-in's sign-in command stays open (like one waiting on a browser): the status ends the wait.
    const providers = await service.login('claude')
    expect(providers[0]).toMatchObject({ loggedIn: true, account: 'ana@example.com · max' })
  })

  it('fails when the sign-in ends without an account', async () => {
    await install('codex', 'case "$1" in --version) echo "0.1.0";; login) if [ "$2" = "status" ]; then echo "Not logged in"; exit 1; fi; echo "denied" >&2; exit 1;; esac')
    expect(await errorCodeOf(createService().login('codex'))).toBe('ai-login-failed')
  })

  it('cannot sign in a tool that is not installed, or one that signs in by itself', async () => {
    expect(await errorCodeOf(createService().login('claude'))).toBe('ai-unavailable')
    await install('agy', 'echo 1.2.16')
    expect(await errorCodeOf(createService().login('agy'))).toBe('ai-login-failed')
  })
})

/**
 * The tools really installed on this machine. Not part of the normal run:
 *
 *   SCREENRX_AI_LIVE=1 npx vitest run src/main/ai
 */
describe.runIf(process.env['SCREENRX_AI_LIVE'] === '1')('AiSetupService with the installed tools', () => {
  it('finds the three tools signed in, with their models', async () => {
    const realHome = os.homedir()
    const service = new AiSetupService({
      logger,
      searchDirs: [path.join(realHome, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'],
      env: process.env,
      home: realHome
    })
    const providers = await service.providers()
    for (const provider of providers) {
      expect(provider).toMatchObject({ installed: true, loggedIn: true })
      expect(provider.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(providers[1]?.models.length).toBeGreaterThan(1)
    expect(providers[2]?.models.length).toBeGreaterThan(1)
  }, 60_000)
})
