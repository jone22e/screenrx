/**
 * Integration with Screen Live (the meeting app): where it is and the
 * recorder token that lets this app list rooms and record one.
 */
export interface MeetSettings {
  /** Origin of the meeting app, e.g. `https://meet.exemplo.com`. Empty when not configured. */
  baseUrl: string
  /** `API_RECORDER_TOKEN` of that server (lists rooms and issues recorder tokens only). */
  token: string
}

export const EMPTY_MEET_SETTINGS: MeetSettings = { baseUrl: '', token: '' }

/** A room as the meeting app lists it: rooms exist only while someone is in them. */
export interface MeetRoom {
  code: string
  name: string
  url: string
  createdAt: string
  /** People in the room; recorders are not counted. */
  participantCount: number
  /** A recorder (this app or another) is already in the room. */
  recording: boolean
}

/** Trailing slashes and surrounding spaces are never part of the origin. */
export function normalizeMeetBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function parseMeetSettings(value: unknown): MeetSettings {
  if (typeof value !== 'object' || value === null) return EMPTY_MEET_SETTINGS
  const { baseUrl, token } = value as Record<string, unknown>
  return {
    baseUrl: typeof baseUrl === 'string' ? normalizeMeetBaseUrl(baseUrl) : '',
    token: typeof token === 'string' ? token.trim() : ''
  }
}

/** Both the address and the token are needed; the address must be http(s). */
export function isMeetConfigured(settings: MeetSettings): boolean {
  return /^https?:\/\/\S+$/.test(settings.baseUrl) && settings.token.length > 0
}
