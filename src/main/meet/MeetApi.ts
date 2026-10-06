import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { MeetRoom, MeetSettings } from '@shared/models/meet'
import { isMeetConfigured } from '@shared/models/meet'

/** A recorder join token, as issued by `POST /api/rooms/{code}/join-tokens` with `recorder: true`. */
export interface RecorderTicket {
  token: string
  /** Page that joins the room straight away as a recorder. */
  url: string
}

export interface MeetRoomStatus {
  active: boolean
  name: string
  participantCount: number
  recording: boolean
}

/** Failure of a call to the meeting app, already translated for the user. */
export class MeetError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 8000

/**
 * The meeting app's integration API, restricted to what a recorder may do:
 * list rooms, read a room and issue recorder tokens. Everything goes through
 * the main process, so the token never reaches a renderer.
 */
export class MeetApi {
  constructor(private readonly fetchImpl: Fetch = (url, init) => fetch(url, init)) {}

  async listRooms(settings: MeetSettings): Promise<MeetRoom[]> {
    const body = (await this.call(settings, 'GET', '/api/rooms')) as { rooms?: unknown }
    if (!Array.isArray(body.rooms)) throw new MeetError(appError('meet-failed', 'rooms missing'))
    return body.rooms.map(parseRoom).filter((room): room is MeetRoom => room !== null)
  }

  /** `active: false` when nobody is in the room (the server answers 404). */
  async roomStatus(settings: MeetSettings, code: string): Promise<MeetRoomStatus> {
    const body = (await this.call(settings, 'GET', `/api/rooms/${encodeURIComponent(code)}`, undefined, [404])) as Record<string, unknown>
    return {
      active: body['active'] === true,
      name: typeof body['name'] === 'string' ? body['name'] : '',
      participantCount: typeof body['participantCount'] === 'number' ? body['participantCount'] : 0,
      recording: body['recording'] === true
    }
  }

  async issueRecorderToken(settings: MeetSettings, code: string, name: string): Promise<RecorderTicket> {
    const body = (await this.call(settings, 'POST', `/api/rooms/${encodeURIComponent(code)}/join-tokens`, {
      name,
      recorder: true
    })) as Record<string, unknown>
    const { token, url } = body
    if (typeof token !== 'string' || typeof url !== 'string') throw new MeetError(appError('meet-failed', 'token missing'))
    // Without PUBLIC_URL the server answers a path ("/live/CODE?t=..."): it is resolved against the configured address.
    return { token, url: new URL(url, `${settings.baseUrl}/`).href }
  }

  private async call(
    settings: MeetSettings,
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
    acceptedErrors: number[] = []
  ): Promise<unknown> {
    if (!isMeetConfigured(settings)) throw new MeetError(appError('meet-not-configured'))
    let response: Response
    try {
      response = await this.fetchImpl(`${settings.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${settings.token}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' })
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      throw new MeetError(appError('meet-unreachable', String(error)))
    }
    if (response.status === 401 || response.status === 403) {
      throw new MeetError(appError('meet-unauthorized', `${method} ${route} → ${response.status}`))
    }
    if (!response.ok && !acceptedErrors.includes(response.status)) {
      throw new MeetError(appError('meet-failed', `${method} ${route} → ${response.status}`))
    }
    try {
      return await response.json()
    } catch (error) {
      throw new MeetError(appError('meet-failed', `invalid json: ${String(error)}`))
    }
  }
}

function parseRoom(value: unknown): MeetRoom | null {
  if (typeof value !== 'object' || value === null) return null
  const { code, name, url, createdAt, participantCount, recording } = value as Record<string, unknown>
  if (typeof code !== 'string' || typeof url !== 'string') return null
  return {
    code,
    name: typeof name === 'string' && name.length > 0 ? name : code,
    url,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    participantCount: typeof participantCount === 'number' ? participantCount : 0,
    recording: recording === true
  }
}
