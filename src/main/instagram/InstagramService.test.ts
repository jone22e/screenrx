import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PublishProgress } from '@shared/models/instagram'
import type { Logger } from '../logging/logger'
import { SessionStore } from '../recording/SessionStore'
import { InstagramGraph, LOGIN_REDIRECT, graphError } from './InstagramGraph'
import type { FetchLike } from './InstagramGraph'
import { InstagramService } from './InstagramService'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

/** A stand-in for Meta: answers by route, records every call (the upload's body read as text). */
function fakeMeta(statuses: string[] = ['IN_PROGRESS', 'FINISHED']) {
  const calls: Call[] = []
  const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const fetcher: FetchLike = async (url, init) => {
    const body = init?.body ? await new Response(init.body as ConstructorParameters<typeof Response>[0]).text() : ''
    calls.push({ method: init?.method ?? 'GET', url, headers: (init?.headers ?? {}) as Record<string, string>, body })
    const { pathname, searchParams } = new URL(url)
    if (pathname.endsWith('/oauth/access_token')) return json({ access_token: `long-${searchParams.get('fb_exchange_token')}`, expires_in: 5_184_000 })
    if (pathname.endsWith('/me/accounts'))
      return json({
        data: [
          { id: 'page-1', name: 'Minha Página', access_token: 'page-token', instagram_business_account: { id: 'ig-1', username: 'jone.dev', name: 'Jone' } },
          { id: 'page-2', name: 'Sem Instagram', access_token: 'other' }
        ]
      })
    if (pathname.endsWith('/debug_token')) return json({ data: { is_valid: true, expires_at: 0 } })
    if (pathname.endsWith('/content_publishing_limit')) return json({ data: [{ quota_usage: 3 }] })
    if (pathname.endsWith('/ig-1/media')) return json({ id: 'container-9', uri: 'https://rupload.facebook.com/ig-api-upload/v24.0/container-9' })
    if (url.startsWith('https://rupload.facebook.com/')) return json({ success: true, message: 'Upload successful.' })
    if (pathname.endsWith('/container-9')) return json({ status_code: statuses.shift() ?? 'FINISHED' })
    if (pathname.endsWith('/ig-1/media_publish')) return json({ id: 'media-77' })
    if (pathname.endsWith('/media-77')) return json({ permalink: 'https://www.instagram.com/reel/abc/' })
    return json({ error: { message: 'unknown route', code: 100 } }, 400)
  }
  return { calls, fetcher }
}

describe('InstagramService', () => {
  let directory: string
  let sessions: SessionStore
  let progress: PublishProgress[]

  const service = (fetcher: FetchLike, redirect: string | null = `${LOGIN_REDIRECT}#access_token=short-1&expires_in=3600`) =>
    new InstagramService({
      directory,
      sessions,
      graph: new InstagramGraph(fetcher),
      secrets: { encrypt: (plain) => `sealed:${Buffer.from(plain).toString('base64')}`, decrypt: (sealed) => Buffer.from(sealed.slice(7), 'base64').toString() },
      openLogin: async () => redirect,
      logger: silentLogger,
      onProgress: (entry) => progress.push(entry),
      onChanged: () => {},
      now: () => new Date('2026-11-19T12:00:00Z'),
      sleep: async () => {}
    })

  const makeRecording = async (): Promise<{ id: string; file: string }> => {
    const created = await sessions.create(
      { source: { kind: 'file', label: 'Aula 1', displayId: null, windowId: null, appName: null }, fps: 30, cursorInVideo: true },
      new Date(2026, 10, 19, 10, 0, 0, 0)
    )
    await sessions.write({ ...created.manifest, status: 'completed', clock: { durationMs: 30_000, pauses: [] } })
    const file = path.join(created.directory, 'reels.mp4')
    await writeFile(file, 'fake mp4 bytes')
    return { id: created.manifest.id, file }
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-instagram-'))
    sessions = new SessionStore(path.join(directory, 'recordings'), silentLogger)
    progress = []
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('connects through the login window, making the token last with the app secret', async () => {
    const meta = fakeMeta()
    const instagram = service(meta.fetcher)
    await instagram.configure('123456789', 'shh-secret', '')
    const status = await instagram.login()
    expect(status.account).toMatchObject({ igUserId: 'ig-1', username: 'jone.dev', pageName: 'Minha Página' })
    expect(status.expiresAt).toBeNull()
    expect(status.hasAppSecret).toBe(true)
    // The short token was exchanged, and the Pages were asked for with the long one.
    expect(meta.calls.find((call) => call.url.includes('/me/accounts'))?.url).toContain('access_token=long-short-1')
    // Nothing secret is on disk in the clear.
    const onDisk = await readFile(path.join(directory, 'instagram.json'), 'utf8')
    expect(onDisk).not.toContain('page-token')
    expect(onDisk).not.toContain('shh-secret')
    // And it reads back after a restart.
    const again = await service(meta.fetcher).status()
    expect(again.account?.username).toBe('jone.dev')
  })

  it('switching asks Facebook again and offers every account, even a single one', async () => {
    let asked = ''
    const meta = fakeMeta()
    const instagram = new InstagramService({
      directory,
      sessions,
      graph: new InstagramGraph(meta.fetcher),
      secrets: null,
      openLogin: async (url) => {
        asked = url
        return `${LOGIN_REDIRECT}#access_token=short-2`
      },
      logger: silentLogger,
      onProgress: () => {},
      onChanged: () => {}
    })
    await instagram.configure('123456789', null, '')
    expect((await instagram.login()).account?.username).toBe('jone.dev')
    expect(new URL(asked).searchParams.has('auth_type')).toBe(false)
    const switching = await instagram.login(true)
    expect(new URL(asked).searchParams.get('auth_type')).toBe('rerequest')
    expect(switching.choices.map((choice) => choice.username)).toEqual(['jone.dev'])
    expect((await instagram.choose('ig-1')).choices).toEqual([])
  })

  it('fails clearly when the login is refused or the account is not professional', async () => {
    const refused = service(fakeMeta().fetcher, `${LOGIN_REDIRECT}?error=access_denied&error_description=Permissions+error`)
    await refused.configure('123456789', null, '')
    await expect(refused.login()).rejects.toMatchObject({ appError: { code: 'instagram-login-failed' } })

    const none: FetchLike = async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    const empty = service(none)
    await expect(empty.connectWithToken('abc')).rejects.toMatchObject({ appError: { code: 'instagram-no-account' } })
  })

  it('publishes an approved recording: container, upload, processing, post', async () => {
    const meta = fakeMeta(['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'])
    const instagram = service(meta.fetcher)
    await instagram.connectWithToken('user-token')
    const { id, file } = await makeRecording()
    await instagram.approve([{ sessionId: id, caption: '  Primeira aula!\r\n\r\n\r\n#dev  ' }])
    expect((await sessions.read(id))?.publish).toMatchObject({ state: 'approved', caption: 'Primeira aula!\n\n#dev', username: 'jone.dev' })

    const record = await instagram.publish(id, file)
    expect(record).toMatchObject({ state: 'published', mediaId: 'media-77', permalink: 'https://www.instagram.com/reel/abc/' })
    expect((await sessions.list())[0]?.publish).toEqual({ state: 'published', caption: 'Primeira aula!\n\n#dev', permalink: 'https://www.instagram.com/reel/abc/', error: null })

    const create = meta.calls.find((call) => call.url.endsWith('/ig-1/media'))
    expect(new URLSearchParams(create?.body)).toMatchObject(new URLSearchParams({ access_token: 'page-token', media_type: 'REELS', upload_type: 'resumable', caption: 'Primeira aula!\n\n#dev', share_to_feed: 'true' }))
    const upload = meta.calls.find((call) => call.url.startsWith('https://rupload'))
    expect(upload?.headers).toMatchObject({ Authorization: 'OAuth page-token', offset: '0', file_size: String('fake mp4 bytes'.length) })
    expect(upload?.body).toBe('fake mp4 bytes')
    expect(meta.calls.filter((call) => call.url.startsWith('https://graph.facebook.com/') && call.url.includes('/container-9?')).length).toBe(3)
    expect(progress.map((entry) => entry.state)).toEqual(expect.arrayContaining(['uploading', 'processing', 'published']))
  })

  it('marks the recording failed with Meta’s reason when processing fails', async () => {
    const meta = fakeMeta(['ERROR'])
    const instagram = service(meta.fetcher)
    await instagram.connectWithToken('user-token')
    const { id, file } = await makeRecording()
    await instagram.approve([{ sessionId: id, caption: 'x' }])
    await expect(instagram.publish(id, file)).rejects.toMatchObject({ appError: { code: 'instagram-failed' } })
    expect((await sessions.read(id))?.publish?.state).toBe('failed')
    // A failed one can be taken out of the queue; a published one cannot be approved over.
    await instagram.withdraw(id)
    expect((await sessions.read(id))?.publish).toBeUndefined()
  })

  it('refuses to publish without an account, and requeues what a quit cut short', async () => {
    const instagram = service(fakeMeta().fetcher)
    const { id, file } = await makeRecording()
    await instagram.approve([{ sessionId: id, caption: '' }])
    await expect(instagram.publish(id, file)).rejects.toMatchObject({ appError: { code: 'instagram-not-connected' } })
    // Not left looking as if it were still on its way.
    expect((await sessions.read(id))?.publish).toMatchObject({ state: 'failed', error: expect.stringContaining('Conecte') })
    await instagram.approve([{ sessionId: id, caption: '' }])
    await instagram.mark(id, 'rendering')
    expect(await sessions.requeueInterruptedPublishes()).toEqual([id])
    expect((await sessions.read(id))?.publish?.state).toBe('approved')
  })
})

describe('graphError', () => {
  it('tells an expired token and the posting limit apart from other failures, without the token', () => {
    expect(graphError(400, { code: 190, message: 'Error validating access token' }).code).toBe('instagram-unauthorized')
    expect(graphError(400, { code: 9, error_subcode: 2207042, message: 'limit' }).code).toBe('instagram-limit')
    const other = graphError(400, { code: 100, message: 'bad access_token=SECRET&x', error_user_msg: 'O vídeo é curto demais.' })
    expect(other.code).toBe('instagram-failed')
    expect(other.message).toContain('O vídeo é curto demais.')
    expect(other.detail).not.toContain('SECRET')
  })
})

describe('InstagramGraph.loginUrl', () => {
  it('asks for the publishing permissions, or names the configuration instead', () => {
    const withScopes = new URL(InstagramGraph.loginUrl('123', '', 'st'))
    expect(withScopes.searchParams.get('scope')).toContain('instagram_content_publish')
    expect(withScopes.searchParams.get('redirect_uri')).toBe(LOGIN_REDIRECT)
    const withConfig = new URL(InstagramGraph.loginUrl('123', '987654', 'st'))
    expect(withConfig.searchParams.get('config_id')).toBe('987654')
    expect(withConfig.searchParams.has('scope')).toBe(false)
  })
})
