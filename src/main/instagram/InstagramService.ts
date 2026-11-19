import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { appError } from '@shared/models/errors'
import type { InstagramAccount, InstagramStatus, PublishProgress, PublishRecord } from '@shared/models/instagram'
import { normalizeCaption } from '@shared/models/instagram'
import { writeJsonAtomic } from '../filesystem/atomicWrite'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import type { ReachableAccount } from './InstagramGraph'
import { InstagramError, InstagramGraph, LOGIN_REDIRECT } from './InstagramGraph'

/** Encrypts what is kept on disk with the system keychain; `null` where that is not available. */
export interface SecretBox {
  encrypt(plain: string): string
  decrypt(sealed: string): string
}

/** Opens Facebook's login and resolves with the user token from the redirect; `null` when the window is closed. */
export type LoginWindow = (url: string, redirect: string) => Promise<string | null>

export interface InstagramServiceDeps {
  directory: string
  sessions: SessionStore
  graph: InstagramGraph
  secrets: SecretBox | null
  openLogin: LoginWindow
  logger: Logger
  onProgress: (progress: PublishProgress) => void
  onChanged: () => void
  now?: () => Date
  /** Between two looks at how Meta's processing is going. */
  pollIntervalMs?: number
  /** How long Meta may take to process a video before the publish gives up. */
  processingTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

interface StoredFile {
  appId: string
  configId: string
  appSecret: string | null
  account: InstagramAccount | null
  pageToken: string | null
  expiresAt: string | null
  /** Accounts the last login reached, with their tokens, while one is to be picked. */
  choices: Array<InstagramAccount & { pageToken: string }>
}

const FILE_NAME = 'instagram.json'
const EMPTY: StoredFile = { appId: '', configId: '', appSecret: null, account: null, pageToken: null, expiresAt: null, choices: [] }
const APP_ID_PATTERN = /^\d{5,20}$/

/**
 * The Instagram connection and the publishing of Reels. The tokens and the
 * app secret are kept by the main process alone, sealed with the keychain
 * when it is there; the renderer only ever learns who is connected.
 */
export class InstagramService {
  private stored: StoredFile | null = null
  private publishing: string | null = null

  constructor(private readonly deps: InstagramServiceDeps) {}

  async status(): Promise<InstagramStatus> {
    const stored = await this.load()
    return {
      appId: stored.appId,
      hasAppSecret: stored.appSecret !== null && stored.appSecret !== '',
      configId: stored.configId,
      account: stored.account,
      expiresAt: stored.expiresAt,
      choices: stored.choices.map(publicAccount)
    }
  }

  /** The Meta app the login goes through. An empty secret keeps the one there is; `null` removes it. */
  async configure(appId: string, appSecret: string | null, configId: string): Promise<InstagramStatus> {
    const stored = await this.load()
    const id = appId.trim()
    if (id !== '' && !APP_ID_PATTERN.test(id)) throw new InstagramError(appError('invalid-state', 'app id must be digits'))
    const config = configId.trim()
    if (config !== '' && !APP_ID_PATTERN.test(config)) throw new InstagramError(appError('invalid-state', 'configuration id must be digits'))
    await this.save({
      ...stored,
      appId: id,
      configId: config,
      appSecret: appSecret === null ? null : appSecret.trim() === '' ? stored.appSecret : appSecret.trim()
    })
    return this.status()
  }

  /**
   * Logs in through Facebook in a window of its own and connects the account found (or offers the
   * ones found). `switching`: Facebook asks again which Pages to share, and every account reached is
   * offered, even when one is connected.
   */
  async login(switching = false): Promise<InstagramStatus> {
    const stored = await this.load()
    if (!stored.appId) throw new InstagramError(appError('instagram-login-failed', 'no app id'))
    const state = randomUUID()
    const redirect = await this.deps.openLogin(InstagramGraph.loginUrl(stored.appId, stored.configId, state, switching), LOGIN_REDIRECT)
    if (redirect === null) throw new InstagramError(appError('instagram-login-failed', 'login window closed'))
    const fragment = new URLSearchParams(new URL(redirect).hash.replace(/^#/, ''))
    const query = new URL(redirect).searchParams
    if (query.get('error') || fragment.get('error')) {
      throw new InstagramError(appError('instagram-login-failed', `${query.get('error') ?? fragment.get('error')}: ${query.get('error_description') ?? fragment.get('error_description') ?? ''}`))
    }
    const token = fragment.get('access_token')
    if (!token) throw new InstagramError(appError('instagram-login-failed', 'no access token in the redirect'))
    if (fragment.get('state') !== null && fragment.get('state') !== state) throw new InstagramError(appError('instagram-login-failed', 'state mismatch'))
    return this.connectWithToken(token, switching)
  }

  /**
   * Connects with a user token got some other way (Graph API Explorer). With
   * the app secret it is made to last first, so the Page token taken from it
   * does not run out.
   */
  async connectWithToken(userToken: string, offerAll = false): Promise<InstagramStatus> {
    const { graph, logger } = this.deps
    const stored = await this.load()
    let token = userToken.trim()
    if (token === '') throw new InstagramError(appError('instagram-login-failed', 'empty token'))
    if (stored.appId && stored.appSecret) {
      token = (await graph.longLived(stored.appId, stored.appSecret, token)).token
    }
    const accounts = await graph.accounts(token)
    logger.info('instagram login', { accounts: accounts.length, longLived: Boolean(stored.appSecret) })
    if (accounts.length === 0) throw new InstagramError(appError('instagram-no-account'))
    if (accounts.length === 1 && !offerAll) return this.useAccount(accounts[0] as ReachableAccount)
    await this.save({ ...stored, choices: accounts })
    return this.status()
  }

  /** Picks one of the accounts the last login reached. */
  async choose(igUserId: string): Promise<InstagramStatus> {
    const stored = await this.load()
    const picked = stored.choices.find((entry) => entry.igUserId === igUserId)
    if (!picked) throw new InstagramError(appError('invalid-state', 'unknown account'))
    return this.useAccount(picked)
  }

  async disconnect(): Promise<InstagramStatus> {
    const stored = await this.load()
    await this.save({ ...stored, account: null, pageToken: null, expiresAt: null, choices: [] })
    this.deps.logger.info('instagram disconnected')
    return this.status()
  }

  /** Approves recordings for publishing, with their captions; the renderer's queue takes them from here. */
  async approve(entries: Array<{ sessionId: string; caption: string }>): Promise<void> {
    const stored = await this.load()
    const now = (this.deps.now ?? (() => new Date()))().toISOString()
    for (const { sessionId, caption } of entries) {
      await this.deps.sessions.updatePublish(sessionId, (current) =>
        current?.state === 'published' || (current && current.state !== 'approved' && current.state !== 'failed')
          ? current
          : { state: 'approved', caption: normalizeCaption(caption), approvedAt: now, username: stored.account?.username ?? null }
      )
    }
    this.deps.onChanged()
  }

  /** Takes a recording out of the queue; one already under way or published stays as it is. */
  async withdraw(sessionId: string): Promise<void> {
    if (this.publishing === sessionId) throw new InstagramError(appError('invalid-state', 'publish under way'))
    await this.deps.sessions.updatePublish(sessionId, (current) => (current && (current.state === 'approved' || current.state === 'failed' || current.state === 'rendering') ? null : current))
    this.deps.onChanged()
  }

  /** Marks where a recording is while the renderer makes its file (`rendering`), or when that failed. */
  async mark(sessionId: string, state: 'rendering' | 'approved' | 'failed', error?: string): Promise<void> {
    await this.deps.sessions.updatePublish(sessionId, (current) => {
      if (!current || current.state === 'published') return current
      const next: PublishRecord = { ...current, state }
      if (state === 'failed') next.error = error ?? 'Não foi possível preparar o vídeo.'
      else delete next.error
      return next
    })
    this.deps.onProgress({ sessionId, state, fraction: null })
    this.deps.onChanged()
  }

  /**
   * Publishes the recording's Reels file, which the renderer has just made:
   * a container, the file sent to Meta, Meta's processing waited for, then
   * the post. Each step is written to the recording, so the library shows it
   * and a restart knows where it stopped.
   */
  async publish(sessionId: string, filePath: string): Promise<PublishRecord> {
    const { graph, sessions, logger } = this.deps
    if (this.publishing) throw new InstagramError(appError('invalid-state', 'another publish under way'))
    const stored = await this.load()
    const manifest = await sessions.read(sessionId)
    const record = manifest?.publish
    if (!record) throw new InstagramError(appError('invalid-state', 'not approved'))
    if (!stored.account || !stored.pageToken) {
      // The file is made, but there is nobody to send it as (the access was lost): the card says so.
      const failure = appError('instagram-not-connected')
      await sessions.updatePublish(sessionId, (current) => (current ? { ...current, state: 'failed', error: failure.message } : current))
      this.deps.onProgress({ sessionId, state: 'failed', fraction: null })
      this.deps.onChanged()
      throw new InstagramError(failure)
    }
    const { account, pageToken: token } = stored
    this.publishing = sessionId
    const startedAt = Date.now()
    const step = async (state: PublishRecord['state'], fraction: number | null = null): Promise<void> => {
      await sessions.updatePublish(sessionId, (current) => (current ? { ...current, state, username: account.username } : current))
      this.deps.onProgress({ sessionId, state, fraction })
      this.deps.onChanged()
    }
    try {
      const used = await graph.publishedToday(account.igUserId, token).catch(() => null)
      if (used !== null && used >= 100) throw new InstagramError(appError('instagram-limit', `quota_usage=${used}`))

      await step('uploading', 0)
      const { containerId, uploadUri } = await graph.createReel(account.igUserId, token, record.caption)
      let lastReport = 0
      await graph.upload(uploadUri, token, filePath, (sent, total) => {
        const now = Date.now()
        if (now - lastReport < 500 && sent < total) return
        lastReport = now
        this.deps.onProgress({ sessionId, state: 'uploading', fraction: total > 0 ? sent / total : null })
      })

      await step('processing')
      await this.waitProcessed(containerId, token)
      const mediaId = await graph.publish(account.igUserId, token, containerId)
      const permalink = await graph.permalink(mediaId, token)
      const publishedAt = (this.deps.now ?? (() => new Date()))().toISOString()
      const done = await sessions.updatePublish(sessionId, (current) => {
        const next: PublishRecord = { ...(current ?? record), state: 'published', publishedAt, mediaId, username: account.username }
        if (permalink) next.permalink = permalink
        delete next.error
        return next
      })
      logger.info('published to instagram', { sessionId, mediaId, account: account.username, elapsedMs: Date.now() - startedAt })
      this.deps.onProgress({ sessionId, state: 'published', fraction: 1 })
      this.deps.onChanged()
      return done as PublishRecord
    } catch (error) {
      const failure = error instanceof InstagramError ? error.appError : appError('instagram-failed', String(error))
      logger.error('instagram publish failed', { sessionId, code: failure.code, detail: failure.detail })
      await sessions.updatePublish(sessionId, (current) => (current ? { ...current, state: 'failed', error: failure.message } : current))
      this.deps.onProgress({ sessionId, state: 'failed', fraction: null })
      this.deps.onChanged()
      throw error instanceof InstagramError ? error : new InstagramError(failure)
    } finally {
      this.publishing = null
    }
  }

  private async waitProcessed(containerId: string, token: string): Promise<void> {
    const interval = this.deps.pollIntervalMs ?? 10_000
    const deadline = Date.now() + (this.deps.processingTimeoutMs ?? 15 * 60_000)
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (;;) {
      const status = await this.deps.graph.containerStatus(containerId, token)
      if (status.code === 'FINISHED' || status.code === 'PUBLISHED') return
      if (status.code === 'ERROR' || status.code === 'EXPIRED') {
        const failed = appError('instagram-failed', `container ${status.code}: ${status.detail ?? ''}`)
        throw new InstagramError(status.detail ? { ...failed, message: `${failed.message} (${status.detail})` } : failed)
      }
      if (Date.now() > deadline) throw new InstagramError(appError('instagram-failed', 'processing timed out'))
      await sleep(interval)
    }
  }

  private async useAccount(account: ReachableAccount): Promise<InstagramStatus> {
    const stored = await this.load()
    const expires = await this.deps.graph.expiry(account.pageToken).catch(() => null)
    await this.save({ ...stored, account: publicAccount(account), pageToken: account.pageToken, expiresAt: expires ? expires.toISOString() : null, choices: [] })
    this.deps.logger.info('instagram connected', { account: account.username, expires: expires?.toISOString() ?? 'never' })
    return this.status()
  }

  private async load(): Promise<StoredFile> {
    if (this.stored) return this.stored
    try {
      const raw = JSON.parse(await readFile(path.join(this.deps.directory, FILE_NAME), 'utf8')) as Record<string, unknown>
      const open = (value: unknown): string | null => {
        if (typeof value !== 'string' || value === '') return null
        if (!this.deps.secrets) return value
        try {
          return this.deps.secrets.decrypt(value)
        } catch {
          return null
        }
      }
      const choices = Array.isArray(raw.choices) ? (raw.choices as Array<Record<string, unknown>>) : []
      this.stored = {
        appId: typeof raw.appId === 'string' ? raw.appId : '',
        configId: typeof raw.configId === 'string' ? raw.configId : '',
        appSecret: open(raw.appSecret),
        account: parseAccount(raw.account),
        pageToken: open(raw.pageToken),
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
        choices: choices.flatMap((entry) => {
          const account = parseAccount(entry)
          const pageToken = open(entry.pageToken)
          return account && pageToken ? [{ ...account, pageToken }] : []
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.logger.warn('could not read instagram settings', { error: String(error) })
      this.stored = { ...EMPTY }
    }
    return this.stored
  }

  private async save(next: StoredFile): Promise<void> {
    const seal = (value: string | null): string | null => (value === null || value === '' ? null : this.deps.secrets ? this.deps.secrets.encrypt(value) : value)
    await writeJsonAtomic(path.join(this.deps.directory, FILE_NAME), {
      appId: next.appId,
      configId: next.configId,
      appSecret: seal(next.appSecret),
      account: next.account,
      pageToken: seal(next.pageToken),
      expiresAt: next.expiresAt,
      choices: next.choices.map((entry) => ({ ...publicAccount(entry), pageToken: seal(entry.pageToken) }))
    })
    this.stored = next
  }
}

function publicAccount(account: InstagramAccount): InstagramAccount {
  const { igUserId, username, name, pictureUrl, pageId, pageName } = account
  return { igUserId, username, name, pictureUrl, pageId, pageName }
}

function parseAccount(value: unknown): InstagramAccount | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.igUserId !== 'string' || typeof entry.username !== 'string' || typeof entry.pageId !== 'string') return null
  return {
    igUserId: entry.igUserId,
    username: entry.username,
    name: typeof entry.name === 'string' ? entry.name : '',
    pictureUrl: typeof entry.pictureUrl === 'string' ? entry.pictureUrl : null,
    pageId: entry.pageId,
    pageName: typeof entry.pageName === 'string' ? entry.pageName : ''
  }
}
