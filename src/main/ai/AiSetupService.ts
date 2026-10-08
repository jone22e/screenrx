import { open, readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AiModel, AiProvider, AiProviderId } from '@shared/models/ai'
import { AI_PROVIDER_IDS } from '@shared/models/ai'
import { appError } from '@shared/models/errors'
import type { Logger } from '../logging/logger'
import { AiError } from './AiCliService'
import {
  ACCOUNT_DEFAULT_MODEL,
  AI_PROVIDER_SPECS,
  CLAUDE_MODELS,
  claudeModelsSeen,
  parseAgyModels,
  parseClaudeSessionModels,
  parseCodexCatalog
} from './aiCatalog'
import { lastLine, locateBinary, runTool, toolEnv } from './cliProcess'

export interface AiSetupOptions {
  logger: Logger
  searchDirs: string[]
  env: NodeJS.ProcessEnv
  /** The user's home: where the tools keep their own state, and where they install themselves. */
  home: string
  /** How the vendor's installer is run; replaced in tests. */
  installCommand?: (installerUrl: string) => { command: string; args: string[] }
  loginPollMs?: number
  loginTimeoutMs?: number
}

const STATUS_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000
const DEFAULT_LOGIN_POLL_MS = 3000
/** How long a look at the tools stays fresh: opening the panel again should not start a dozen processes. */
const STATUS_TTL_MS = 60_000
/** Antigravity's models are asked from its service, so they are kept for longer. */
const AGY_MODELS_TTL_MS = 60 * 60_000
/** Claude's models come from reading its session logs, which is a bit of disk work. */
const CLAUDE_MODELS_TTL_MS = 10 * 60_000
/** How many of the most recent session logs are read, and how much of the end of each. */
const CLAUDE_SESSIONS_READ = 40
const CLAUDE_SESSION_TAIL_BYTES = 512 * 1024
/** Models used longer ago than this are not offered. */
const CLAUDE_MODEL_MAX_AGE_MS = 90 * 24 * 60 * 60_000
const CLAUDE_MODELS_OFFERED = 12

/** The vendor's installer, exactly as its site says to run it: no questions asked, into `~/.local/bin`. */
const runInstaller = (installerUrl: string): { command: string; args: string[] } => ({
  command: '/bin/bash',
  args: ['-c', `curl -fsSL ${installerUrl} | bash`]
})

const versionIn = (text: string): string | null => /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null

/**
 * The state of the AI tools on this machine — installed, which version,
 * signed in, which models — and the two things the app can do about it:
 * install a tool with its vendor's installer, and start its sign-in.
 */
export class AiSetupService {
  private cache: { at: number; providers: Promise<AiProvider[]> } | null = null
  private agyModels: { at: number; models: AiModel[] } | null = null
  private claudeModels: { at: number; models: AiModel[] } | null = null
  private working: AbortController | null = null

  constructor(private readonly options: AiSetupOptions) {}

  /** Every tool the app knows, as it stands now. */
  providers(refresh = false): Promise<AiProvider[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < STATUS_TTL_MS) return this.cache.providers
    const providers = Promise.all(AI_PROVIDER_IDS.map((id) => this.inspect(id)))
    this.cache = { at: Date.now(), providers }
    return providers
  }

  /** Installs a tool with its vendor's installer and returns the tools as they stand afterwards. */
  async install(id: AiProviderId): Promise<AiProvider[]> {
    if (process.platform === 'win32') throw new AiError(appError('ai-install-failed', 'not supported on Windows yet'))
    const { logger, home, installCommand = runInstaller } = this.options
    const { command, args } = installCommand(AI_PROVIDER_SPECS[id].installer)
    logger.info('installing AI tool', { provider: id })
    const result = await this.exclusively((signal) =>
      runTool(command, args, {
        cwd: home,
        env: this.env({ CODEX_NON_INTERACTIVE: '1' }),
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal
      })
    )
    const providers = await this.providers(true)
    if (!providers.find((provider) => provider.id === id)?.installed) {
      const reason = result.aborted ? 'cancelled' : lastLine(result) || `exit ${result.code}`
      logger.warn('AI tool was not installed', { provider: id, reason })
      throw new AiError(appError('ai-install-failed', reason))
    }
    return providers
  }

  /**
   * Starts a tool's own sign-in — it opens the browser itself — and waits
   * until the tool reports an account, the sign-in ends, or time runs out.
   */
  async login(id: AiProviderId): Promise<AiProvider[]> {
    const { searchDirs, home, logger, loginPollMs = DEFAULT_LOGIN_POLL_MS, loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS } =
      this.options
    const spec = AI_PROVIDER_SPECS[id]
    const binary = await locateBinary(searchDirs, spec.binary)
    if (!binary) throw new AiError(appError('ai-unavailable', `${spec.binary} not found`))
    if (!spec.login) throw new AiError(appError('ai-login-failed', `${spec.binary} signs in on its first run in a terminal`))
    const command = spec.login

    logger.info('starting AI tool sign-in', { provider: id })
    const result = await this.exclusively(async (signal) => {
      // The sign-in command may stay open after the browser is done: watching
      // the tool's own status is what tells when the account is in.
      const done = new AbortController()
      const stop = (): void => done.abort()
      signal.addEventListener('abort', stop, { once: true })
      const poll = setInterval(() => {
        void this.account(id, binary).then((account) => {
          if (account.loggedIn) stop()
        })
      }, loginPollMs)
      try {
        return await runTool(binary, command, {
          cwd: home,
          env: this.env({ NO_COLOR: '1' }),
          timeoutMs: loginTimeoutMs,
          signal: done.signal
        })
      } finally {
        clearInterval(poll)
        signal.removeEventListener('abort', stop)
      }
    })
    const providers = await this.providers(true)
    if (!providers.find((provider) => provider.id === id)?.loggedIn) {
      throw new AiError(appError('ai-login-failed', lastLine(result) || `exit ${result.code}`))
    }
    return providers
  }

  /** Stops an installation or a sign-in in progress. */
  cancel(): void {
    this.working?.abort()
  }

  /** One installation or sign-in at a time. */
  private async exclusively<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.working) throw new AiError(appError('ai-busy'))
    const controller = new AbortController()
    this.working = controller
    try {
      return await work(controller.signal)
    } finally {
      this.working = null
    }
  }

  private async inspect(id: AiProviderId): Promise<AiProvider> {
    const spec = AI_PROVIDER_SPECS[id]
    const base: AiProvider = {
      id,
      label: spec.label,
      toolName: spec.toolName,
      installed: false,
      version: null,
      loggedIn: false,
      account: null,
      canLogIn: spec.login !== null,
      models: id === 'claude' ? CLAUDE_MODELS : [ACCOUNT_DEFAULT_MODEL],
      efforts: spec.efforts,
      defaultEffort: spec.defaultEffort
    }
    const binary = await locateBinary(this.options.searchDirs, spec.binary)
    if (!binary) return base

    const [version, account, models] = await Promise.all([
      this.exec(binary, ['--version']).then(
        (result) => versionIn(result.stdout) ?? versionIn(result.stderr),
        () => null
      ),
      this.account(id, binary),
      this.models(id, binary)
    ])
    return { ...base, installed: true, version, ...account, models }
  }

  /** Whether the tool is signed in, and as whom — asked from the tool, or read from what it stores. */
  private async account(id: AiProviderId, binary: string): Promise<{ loggedIn: boolean; account: string | null }> {
    try {
      if (id === 'claude') {
        const status = JSON.parse((await this.exec(binary, ['auth', 'status', '--json'])).stdout) as Record<string, unknown>
        const who = [status['email'], status['subscriptionType'] ?? status['orgName']]
          .filter((part): part is string => typeof part === 'string' && part !== '')
          .join(' · ')
        return { loggedIn: status['loggedIn'] === true, account: who || null }
      }
      if (id === 'codex') {
        // "Logged in using ChatGPT" with exit code 0; "Not logged in" with another.
        const result = await this.exec(binary, ['login', 'status'])
        const text = `${result.stdout}\n${result.stderr}`.trim()
        const loggedIn = result.code === 0 && !/not logged in/i.test(text)
        return { loggedIn, account: loggedIn ? (text.split('\n')[0]?.slice(0, 80) ?? null) : null }
      }
      // Antigravity has no status command: its stored sign-in says it. Only the e-mail is read from it.
      const stored = JSON.parse(
        await readFile(path.join(this.options.home, '.gemini', 'jetski-standalone-oauth-token'), 'utf8')
      ) as { id_token?: unknown; token?: unknown }
      if (!stored.token && !stored.id_token) return { loggedIn: false, account: null }
      return { loggedIn: true, account: emailOf(stored.id_token) }
    } catch {
      return { loggedIn: false, account: null }
    }
  }

  private async models(id: AiProviderId, binary: string): Promise<AiModel[]> {
    if (id === 'claude') {
      if (!this.claudeModels || Date.now() - this.claudeModels.at > CLAUDE_MODELS_TTL_MS) {
        this.claudeModels = { at: Date.now(), models: await this.claudeModelsFromSessions() }
      }
      return this.claudeModels.models.length > 0 ? this.claudeModels.models : CLAUDE_MODELS
    }
    try {
      if (id === 'codex') {
        const catalog = await readFile(path.join(this.options.home, '.codex', 'models_cache.json'), 'utf8')
        return [ACCOUNT_DEFAULT_MODEL, ...parseCodexCatalog(JSON.parse(catalog))]
      }
      if (!this.agyModels || Date.now() - this.agyModels.at > AGY_MODELS_TTL_MS) {
        const listed = parseAgyModels((await this.exec(binary, ['models'])).stdout)
        if (listed.length === 0) return [ACCOUNT_DEFAULT_MODEL]
        this.agyModels = { at: Date.now(), models: listed }
      }
      return [ACCOUNT_DEFAULT_MODEL, ...this.agyModels.models]
    } catch {
      return [ACCOUNT_DEFAULT_MODEL]
    }
  }

  /**
   * The models Claude Code has run on this machine, from its session logs
   * (`~/.claude/projects/<project>/<session>.jsonl`), most recent first. Only
   * the newest logs are read, and only their ends: every answer names its model.
   */
  private async claudeModelsFromSessions(): Promise<AiModel[]> {
    const root = path.join(this.options.home, '.claude', 'projects')
    const logs: Array<{ file: string; mtimeMs: number }> = []
    const collect = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (depth < 3) await collect(file, depth + 1)
        } else if (entry.name.endsWith('.jsonl')) {
          const info = await stat(file).catch(() => null)
          if (info) logs.push({ file, mtimeMs: info.mtimeMs })
        }
      }
    }
    await collect(root, 0)
    const since = Date.now() - CLAUDE_MODEL_MAX_AGE_MS
    const recent = logs
      .filter((log) => log.mtimeMs >= since)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CLAUDE_SESSIONS_READ)

    const seen = new Map<string, number>()
    for (const log of recent) {
      for (const id of parseClaudeSessionModels(await this.readTail(log.file))) {
        if ((seen.get(id) ?? 0) < log.mtimeMs) seen.set(id, log.mtimeMs)
      }
    }
    return claudeModelsSeen(seen).slice(0, CLAUDE_MODELS_OFFERED)
  }

  private async readTail(file: string): Promise<string> {
    const handle = await open(file, 'r').catch(() => null)
    if (!handle) return ''
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, CLAUDE_SESSION_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } catch {
      return ''
    } finally {
      await handle.close()
    }
  }

  private exec(binary: string, args: string[]) {
    return runTool(binary, args, { cwd: os.tmpdir(), env: this.env(), timeoutMs: STATUS_TIMEOUT_MS })
  }

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return toolEnv(this.options.env, this.options.searchDirs, extra)
  }
}

/** The e-mail claim of a JWT, without verifying it: it is only shown to the user it belongs to. */
function emailOf(idToken: unknown): string | null {
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : undefined
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
    return typeof claims.email === 'string' ? claims.email.slice(0, 120) : null
  } catch {
    return null
  }
}
