/**
 * Publishing to Instagram Reels: the account the app is connected to, and
 * where each approved recording stands. The tokens never leave the main
 * process; the renderer only sees who is connected.
 */

/** The professional Instagram account posts go to, and the Facebook Page it is linked to. */
export interface InstagramAccount {
  igUserId: string
  username: string
  /** The account's display name; empty when it has none. */
  name: string
  pictureUrl: string | null
  pageId: string
  pageName: string
}

export interface InstagramStatus {
  /** The Meta app the login goes through; empty until the user gives it. */
  appId: string
  /** Whether an app secret is kept, which turns a short login into one that lasts. */
  hasAppSecret: boolean
  /** The Facebook Login for Business configuration, when the app uses one instead of permissions. */
  configId: string
  account: InstagramAccount | null
  /** When the access runs out; `null` when it does not (a Page token from a long-lived login). */
  expiresAt: string | null
  /** Accounts found at the last login, when there were several to pick from. */
  choices: InstagramAccount[]
}

/** Where an approved recording is on its way to Instagram. */
export type PublishState =
  /** Approved: waits its turn in the queue. */
  | 'approved'
  /** The Reels file is being rendered on this Mac. */
  | 'rendering'
  /** The file is being sent to Meta. */
  | 'uploading'
  /** Meta has the file and is processing it. */
  | 'processing'
  | 'published'
  | 'failed'

/** Kept in the recording's `session.json` from the moment it is approved. */
export interface PublishRecord {
  state: PublishState
  caption: string
  approvedAt: string
  /** The account it was (or will be) published to. */
  username: string | null
  publishedAt?: string
  mediaId?: string
  permalink?: string
  /** Why it failed, in words for the user. */
  error?: string
}

/** What the library shows of it. */
export interface PublishSummary {
  state: PublishState
  caption: string
  permalink: string | null
  error: string | null
}

/** How far a publish is, for the card under way. */
export interface PublishProgress {
  sessionId: string
  state: PublishState
  /** 0–1 within the state, when known. */
  fraction: number | null
}

/** Instagram's own limits for a caption. */
export const INSTAGRAM_LIMITS = {
  captionChars: 2200,
  hashtags: 30,
  /** Reels the API takes: 3 s to 15 min. */
  minDurationMs: 3000,
  maxDurationMs: 15 * 60 * 1000,
  /** Posts the API takes per account in a moving 24 h. */
  postsPerDay: 100
} as const

const PUBLISH_STATES: readonly PublishState[] = ['approved', 'rendering', 'uploading', 'processing', 'published', 'failed']

export const isPublishState = (value: unknown): value is PublishState => typeof value === 'string' && (PUBLISH_STATES as readonly string[]).includes(value)

/** A caption as Instagram takes it: line breaks kept, trimmed, cut to the limit. */
export function normalizeCaption(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, INSTAGRAM_LIMITS.captionChars)
}

export const hashtagCount = (caption: string): number => (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length

/** A record read back from disk, checked; `null` when it is not one. */
export function parsePublishRecord(value: unknown): PublishRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (!isPublishState(entry.state) || typeof entry.approvedAt !== 'string') return null
  const record: PublishRecord = {
    state: entry.state,
    caption: normalizeCaption(entry.caption),
    approvedAt: entry.approvedAt,
    username: typeof entry.username === 'string' ? entry.username : null
  }
  if (typeof entry.publishedAt === 'string') record.publishedAt = entry.publishedAt
  if (typeof entry.mediaId === 'string') record.mediaId = entry.mediaId
  if (typeof entry.permalink === 'string' && entry.permalink.startsWith('https://')) record.permalink = entry.permalink
  if (typeof entry.error === 'string') record.error = entry.error.slice(0, 500)
  return record
}

export const publishSummaryOf = (record: PublishRecord | undefined): PublishSummary | null =>
  record ? { state: record.state, caption: record.caption, permalink: record.permalink ?? null, error: record.error ?? null } : null

/** Whether the queue still has work to do for it. */
export const isPublishPending = (state: PublishState): boolean => state === 'approved' || state === 'rendering' || state === 'uploading' || state === 'processing'

/** A term or hashtag the AI found to be in demand for the topic now, and why. */
export interface TrendingTerm {
  term: string
  why: string
}

/** A caption written by the AI after looking up what is being searched and posted about the topic. */
export interface CaptionSuggestion {
  caption: string
  /** The topic the research was about (e.g. "GTA 6"), as found or as given. */
  topic: string
  hashtags: string[]
  trends: TrendingTerm[]
  /** Pages the research read; empty when the tool could not search the web. */
  sources: string[]
}

const tidyText = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** A hashtag as Instagram takes it: one word of letters, digits and underscores after #. */
export function normalizeHashtag(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const word = value.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')
  return word.length > 0 && word.length <= 60 ? `#${word.toLocaleLowerCase('pt-BR')}` : null
}

/**
 * The AI's answer, checked: the hashtags tidied and not repeated, at most
 * Instagram's limit, put at the end of the caption when it does not carry them.
 */
export function parseCaptionSuggestion(value: unknown, fallbackTopic: string): CaptionSuggestion | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  const hashtags = [...new Set((Array.isArray(entry.hashtags) ? entry.hashtags : []).map(normalizeHashtag).filter((tag): tag is string => tag !== null))].slice(0, INSTAGRAM_LIMITS.hashtags)
  let caption = normalizeCaption(entry.caption)
  if (caption === '') return null
  const missing = hashtags.filter((tag) => !caption.toLocaleLowerCase('pt-BR').includes(tag))
  if (missing.length > 0) caption = normalizeCaption(`${caption}\n\n${missing.join(' ')}`)
  const trends = (Array.isArray(entry.trends) ? entry.trends : [])
    .map((trend) => (typeof trend === 'object' && trend !== null ? { term: tidyText((trend as Record<string, unknown>).term, 60), why: tidyText((trend as Record<string, unknown>).why, 200) } : null))
    .filter((trend): trend is TrendingTerm => trend !== null && trend.term !== '')
    .slice(0, 12)
  // The tools sometimes add a note after the address: only the address is kept.
  const sources = [
    ...new Set(
      (Array.isArray(entry.sources) ? entry.sources : []).flatMap((source) => {
        const found = typeof source === 'string' ? /^\s*(https?:\/\/[^\s()<>"']+)/.exec(source) : null
        return found?.[1] ? [found[1]] : []
      })
    )
  ].slice(0, 10)
  return { caption, topic: tidyText(entry.topic, 80) || fallbackTopic, hashtags, trends, sources }
}
