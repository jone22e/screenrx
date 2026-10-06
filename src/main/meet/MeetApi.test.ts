import { describe, expect, it } from 'vitest'
import type { MeetSettings } from '@shared/models/meet'
import { MeetApi, MeetError } from './MeetApi'

const settings: MeetSettings = { baseUrl: 'https://meet.exemplo.com', token: 'rec-secret' }

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return {
    calls,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
  }
}

describe('MeetApi', () => {
  it('lists rooms with the recorder token, skipping malformed entries', async () => {
    const { fetch, calls } = fakeFetch(200, {
      rooms: [
        { code: 'ABCDEF', name: 'Daily', url: 'https://meet.exemplo.com/live/ABCDEF', createdAt: '2026-10-06T10:00:00.000Z', participantCount: 3, recording: false },
        { code: 'GHJKLM', name: '', url: 'https://meet.exemplo.com/live/GHJKLM', participantCount: 1, recording: true },
        { nope: true }
      ]
    })
    const rooms = await new MeetApi(fetch).listRooms(settings)

    expect(calls[0]?.url).toBe('https://meet.exemplo.com/api/rooms')
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer rec-secret')
    expect(rooms).toEqual([
      { code: 'ABCDEF', name: 'Daily', url: 'https://meet.exemplo.com/live/ABCDEF', createdAt: '2026-10-06T10:00:00.000Z', participantCount: 3, recording: false },
      { code: 'GHJKLM', name: 'GHJKLM', url: 'https://meet.exemplo.com/live/GHJKLM', createdAt: '', participantCount: 1, recording: true }
    ])
  })

  it('issues a recorder token', async () => {
    const { fetch, calls } = fakeFetch(201, { token: 'tok', url: 'https://meet.exemplo.com/live/ABCDEF?t=tok', recorder: true })
    const ticket = await new MeetApi(fetch).issueRecorderToken(settings, 'ABCDEF', 'Gravação ScreenRx')

    expect(ticket).toEqual({ token: 'tok', url: 'https://meet.exemplo.com/live/ABCDEF?t=tok' })
    expect(calls[0]?.url).toBe('https://meet.exemplo.com/api/rooms/ABCDEF/join-tokens')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ name: 'Gravação ScreenRx', recorder: true })
  })

  it('resolves a relative token url against the configured address', async () => {
    const { fetch } = fakeFetch(201, { token: 'tok', url: '/live/ABCDEF?t=tok' })
    const ticket = await new MeetApi(fetch).issueRecorderToken(settings, 'ABCDEF', 'Gravação ScreenRx')
    expect(ticket.url).toBe('https://meet.exemplo.com/live/ABCDEF?t=tok')
  })

  it('reports an empty room as inactive instead of failing', async () => {
    const status = await new MeetApi(fakeFetch(404, { code: 'ABCDEF', active: false }).fetch).roomStatus(settings, 'ABCDEF')
    expect(status).toEqual({ active: false, name: '', participantCount: 0, recording: false })
  })

  it('translates rejections and outages for the user', async () => {
    const api = new MeetApi(fakeFetch(403, { error: 'nope' }).fetch)
    await expect(api.listRooms(settings)).rejects.toMatchObject({ appError: { code: 'meet-unauthorized' } })

    const offline = new MeetApi(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(offline.listRooms(settings)).rejects.toMatchObject({ appError: { code: 'meet-unreachable' } })

    const unconfigured = new MeetApi(fakeFetch(200, { rooms: [] }).fetch)
    const failure = await unconfigured.listRooms({ baseUrl: '', token: '' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MeetError)
    expect((failure as MeetError).appError.code).toBe('meet-not-configured')
  })
})
