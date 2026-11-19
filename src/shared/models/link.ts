/** Bringing a video into the library from a link (YouTube and the other sites yt-dlp reads). */

export interface LinkToolStatus {
  installed: boolean
  /** `app`: downloaded by ScreenRx; `system`: installed with Homebrew. */
  source: 'app' | 'system' | null
  /** Size of the download when not installed, as GitHub states it; `null` when unknown (offline). */
  downloadBytes: number | null
  version: string | null
}

export interface LinkDownloadProgress {
  url: string
  stage: 'starting' | 'downloading' | 'importing' | 'done'
  fraction: number | null
  /** The video's title, once the site has said it. */
  title: string | null
}

/** The link tidied, or `null` when it is not a web address. Only http(s): no local files, no other schemes. */
export function normalizeVideoLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 2000) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname.includes('.')) return null
    return url.toString()
  } catch {
    return null
  }
}
