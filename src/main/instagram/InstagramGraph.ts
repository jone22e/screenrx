import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { InstagramAccount } from '@shared/models/instagram'

/**
 * The few calls of Meta's Graph API that publishing a Reel takes, through
 * Facebook Login (an Instagram professional account linked to a Facebook
 * Page). That route is the one that takes the video file itself — a
 * resumable upload to `rupload.facebook.com` — so nothing has to be put on
 * a public server first.
 *
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 * https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads
 */

export const GRAPH_VERSION = 'v24.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`
const RUPLOAD = `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}`

/** What the publishing needs to be allowed: read the Pages and their Instagram accounts, and post. */
export const LOGIN_SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'] as const

/**
 * Where Facebook sends the login back to, with the token in the fragment. Nothing answers there:
 * the login window catches the redirect before it loads. Facebook Login for Business refuses its
 * own `facebook.com/connect/login_success.html`, so the app registers this one instead.
 */
export const LOGIN_REDIRECT = 'https://localhost/screenrx/instagram'

export class InstagramError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'InstagramError'
  }
}

export type FetchLike = (url: string, init?: RequestInit & { duplex?: 'half' }) => Promise<Response>

export interface ContainerStatus {
  /** `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR` or `EXPIRED`. */
  code: string
  /** Meta's words when it failed. */
  detail: string | null
}

/** An account the login can reach, with the Page token posts are made with. */
export interface ReachableAccount extends InstagramAccount {
  pageToken: string
}

/** Graph error codes that mean the token is no good any more. */
const AUTH_CODES = new Set([102, 190, 200, 10])
/** "Application request limit reached" and the content publishing limit. */
const LIMIT_CODES = new Set([4, 17, 32, 613, 9, 368])

export class InstagramGraph {
  constructor(private readonly fetcher: FetchLike = (url, init) => fetch(url, init)) {}

  /** The login dialog's address for this app. */
  static loginUrl(appId: string, configId: string, state: string, again = false): string {
    const params = new URLSearchParams({ client_id: appId, redirect_uri: LOGIN_REDIRECT, response_type: 'token', state, display: 'popup' })
    // Asks again which Pages (and so which Instagram accounts) to share, instead of reusing the last answer.
    if (again) params.set('auth_type', 'rerequest')
    // An app on Facebook Login for Business names a configuration instead of permissions.
    if (configId) params.set('config_id', configId)
    else params.set('scope', LOGIN_SCOPES.join(','))
    return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`
  }

  /** A short login token (about 2 h) for one that lasts about 60 days; needs the app secret. */
  async longLived(appId: string, appSecret: string, token: string): Promise<{ token: string; expiresInSec: number | null }> {
    const body = await this.get('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token })
    const accessToken = typeof body.access_token === 'string' ? body.access_token : null
    if (!accessToken) throw new InstagramError(appError('instagram-login-failed', 'no long-lived token in the answer'))
    return { token: accessToken, expiresInSec: typeof body.expires_in === 'number' ? body.expires_in : null }
  }

  /** When a token runs out (`null`: never) — a Page token taken from a long-lived login does not. */
  async expiry(token: string): Promise<Date | null> {
    const body = await this.get('/debug_token', { input_token: token, access_token: token })
    const data = (body.data ?? {}) as Record<string, unknown>
    if (data.is_valid === false) throw new InstagramError(appError('instagram-unauthorized', 'token is not valid'))
    const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : 0
    return expiresAt > 0 ? new Date(expiresAt * 1000) : null
  }

  /** Every professional Instagram account linked to a Page the login manages. */
  async accounts(userToken: string): Promise<ReachableAccount[]> {
    const body = await this.get('/me/accounts', {
      access_token: userToken,
      fields: 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}',
      limit: '100'
    })
    const pages = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : []
    const accounts: ReachableAccount[] = []
    for (const page of pages) {
      const ig = page.instagram_business_account as Record<string, unknown> | undefined
      if (!ig || typeof ig.id !== 'string' || typeof page.access_token !== 'string' || typeof page.id !== 'string') continue
      accounts.push({
        igUserId: ig.id,
        username: typeof ig.username === 'string' ? ig.username : ig.id,
        name: typeof ig.name === 'string' ? ig.name : '',
        pictureUrl: typeof ig.profile_picture_url === 'string' ? ig.profile_picture_url : null,
        pageId: page.id,
        pageName: typeof page.name === 'string' ? page.name : '',
        pageToken: page.access_token
      })
    }
    return accounts
  }

  /** How many posts the API took from the account in the last 24 h. */
  async publishedToday(igUserId: string, token: string): Promise<number | null> {
    const body = await this.get(`/${igUserId}/content_publishing_limit`, { access_token: token, fields: 'quota_usage' })
    const first = Array.isArray(body.data) ? (body.data[0] as Record<string, unknown> | undefined) : undefined
    return typeof first?.quota_usage === 'number' ? first.quota_usage : null
  }

  /** A Reels container that takes the file by resumable upload. */
  async createReel(igUserId: string, token: string, caption: string): Promise<{ containerId: string; uploadUri: string }> {
    const body = await this.post(`/${igUserId}/media`, {
      access_token: token,
      media_type: 'REELS',
      upload_type: 'resumable',
      caption,
      share_to_feed: 'true'
    })
    const containerId = typeof body.id === 'string' ? body.id : null
    if (!containerId) throw new InstagramError(appError('instagram-failed', 'no container id in the answer'))
    const uploadUri = typeof body.uri === 'string' && body.uri.startsWith('https://') ? body.uri : `${RUPLOAD}/${containerId}`
    return { containerId, uploadUri }
  }

  /** Sends the file, reporting the bytes sent; `offset` resumes a cut-short upload. */
  async upload(uploadUri: string, token: string, filePath: string, onProgress: (sent: number, total: number) => void, offset = 0, signal?: AbortSignal): Promise<void> {
    const { size } = await stat(filePath)
    let sent = offset
    const source = createReadStream(filePath, { start: offset })
    source.on('data', (chunk) => {
      sent += chunk.length
      onProgress(sent, size)
    })
    const response = await this.fetcher(uploadUri, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        offset: String(offset),
        file_size: String(size),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size - offset)
      },
      body: Readable.toWeb(source) as unknown as NonNullable<RequestInit['body']>,
      duplex: 'half',
      ...(signal && { signal })
    }).catch((error: unknown) => {
      source.destroy()
      throw new InstagramError(appError('instagram-failed', `upload failed: ${String(error)}`))
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok || body.success !== true) {
      const info = (body.debug_info ?? {}) as Record<string, unknown>
      throw new InstagramError(appError('instagram-failed', `upload refused (${response.status}): ${typeof info.message === 'string' ? info.message : JSON.stringify(body).slice(0, 300)}`))
    }
  }

  async containerStatus(containerId: string, token: string): Promise<ContainerStatus> {
    const body = await this.get(`/${containerId}`, { access_token: token, fields: 'status_code,status' })
    return {
      code: typeof body.status_code === 'string' ? body.status_code : 'IN_PROGRESS',
      detail: typeof body.status === 'string' ? body.status : null
    }
  }

  /** Puts the processed container on the account; the post's id. */
  async publish(igUserId: string, token: string, containerId: string): Promise<string> {
    const body = await this.post(`/${igUserId}/media_publish`, { access_token: token, creation_id: containerId })
    if (typeof body.id !== 'string') throw new InstagramError(appError('instagram-failed', 'no media id in the answer'))
    return body.id
  }

  async permalink(mediaId: string, token: string): Promise<string | null> {
    const body = await this.get(`/${mediaId}`, { access_token: token, fields: 'permalink' }).catch(() => ({}) as Record<string, unknown>)
    return typeof body.permalink === 'string' ? body.permalink : null
  }

  private async get(route: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.call(`${GRAPH}${route}?${new URLSearchParams(params).toString()}`, { method: 'GET' })
  }

  private async post(route: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.call(`${GRAPH}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    })
  }

  private async call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, init).catch((error: unknown) => {
      throw new InstagramError(appError('instagram-failed', `network: ${String(error)}`))
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const failure = body.error as Record<string, unknown> | undefined
    if (response.ok && !failure) return body
    throw new InstagramError(graphError(response.status, failure))
  }
}

/** A Graph error as the user should read it; the token never goes into the detail. */
export function graphError(status: number, failure: Record<string, unknown> | undefined): AppError {
  const code = typeof failure?.code === 'number' ? failure.code : 0
  const subcode = typeof failure?.error_subcode === 'number' ? failure.error_subcode : 0
  const message = typeof failure?.error_user_msg === 'string' ? failure.error_user_msg : typeof failure?.message === 'string' ? failure.message : `HTTP ${status}`
  const detail = `graph ${status} code=${code} subcode=${subcode}: ${message}`.replace(/access_token=[^&\s]+/g, 'access_token=…')
  if (AUTH_CODES.has(code) || status === 401) return appError('instagram-unauthorized', detail)
  if (LIMIT_CODES.has(code) || subcode === 2207042) return appError('instagram-limit', detail)
  const failed = appError('instagram-failed', detail)
  // Meta's own words for what is wrong with the video say more than ours.
  return typeof failure?.error_user_msg === 'string' ? { ...failed, message: `${failed.message} ${failure.error_user_msg}` } : failed
}
