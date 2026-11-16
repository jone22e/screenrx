/**
 * A series made from one recording: the AI splits it into episodes, each
 * becoming a recording of its own in the library, under the series' name.
 */

export interface SeriesEpisode {
  /** On the source recording's clock. */
  startMs: number
  endMs: number
  title: string
}

export interface SeriesPlan {
  seriesTitle: string
  episodes: SeriesEpisode[]
}

/** How the split is going: which episode is being cut now. */
export interface SeriesProgress {
  sessionId: string
  done: number
  total: number
  /** The episode being made now; empty when done. */
  title: string
}

export const SERIES_LIMITS = {
  maxEpisodes: 40,
  minEpisodeMs: 5000,
  maxTitleLength: 80,
  /** Episode lengths the user can ask for, in seconds. */
  targetChoicesSec: [60, 180, 300, 600] as const
} as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const tidy = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * A plan as the renderer sends it back, checked: episodes in order, inside
 * the recording, not overlapping, none too short, each with a title.
 * `null` when there is nothing usable.
 */
export function parseSeriesPlan(value: unknown, durationMs: number): SeriesPlan | null {
  if (!isRecord(value) || !Array.isArray(value.episodes)) return null
  const episodes: SeriesEpisode[] = []
  for (const entry of value.episodes.slice(0, SERIES_LIMITS.maxEpisodes)) {
    if (!isRecord(entry) || typeof entry.startMs !== 'number' || typeof entry.endMs !== 'number') continue
    const startMs = Math.max(0, Math.min(Math.round(entry.startMs), durationMs))
    const endMs = Math.max(0, Math.min(Math.round(entry.endMs), durationMs))
    const previous = episodes.at(-1)
    if (endMs - startMs < SERIES_LIMITS.minEpisodeMs || (previous && startMs < previous.endMs)) continue
    const title = tidy(entry.title, SERIES_LIMITS.maxTitleLength) || `Episódio ${episodes.length + 1}`
    episodes.push({ startMs, endMs, title })
  }
  const seriesTitle = tidy(value.seriesTitle, SERIES_LIMITS.maxTitleLength)
  if (episodes.length === 0 || seriesTitle === '') return null
  return { seriesTitle, episodes }
}
