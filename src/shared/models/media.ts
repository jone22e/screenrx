/** Scheme under which the main process streams recorded media to the renderers. */
export const MEDIA_SCHEME = 'screenrx-media'

export const MEDIA_TRACKS = [
  'screen',
  /** The screen track with the rendered effects applied; derived, made again whenever they change. */
  'screenFx',
  'webcam',
  'microphone',
  'systemAudio',
  'dubEn',
  'dubEs',
  'dubZh',
  'dubPt',
  /** Background music the user brought in. */
  'music'
] as const
export type MediaTrack = (typeof MEDIA_TRACKS)[number]

/** The track that holds the dubbing in each language. */
export const DUB_TRACKS = { en: 'dubEn', es: 'dubEs', zh: 'dubZh', pt: 'dubPt' } as const satisfies Record<
  'en' | 'es' | 'zh' | 'pt',
  MediaTrack
>

export function isMediaTrack(value: unknown): value is MediaTrack {
  return (MEDIA_TRACKS as readonly unknown[]).includes(value)
}

/** URL of the session's cover, or of a poster frame of its screen track. The cover's file name goes in the query so a new cover is never the cached old one. */
export function thumbnailUrl(sessionId: string, cover?: string): string {
  const base = `${MEDIA_SCHEME}://session/${sessionId}/thumbnail`
  return cover ? `${base}?cover=${encodeURIComponent(cover)}` : base
}

/** URL of an image in a session's `assets/` folder. */
export function assetUrl(sessionId: string, file: string): string {
  return `${MEDIA_SCHEME}://session/${sessionId}/asset/${encodeURIComponent(file)}`
}

/** URL of one of a session's tracks. The renderer never sees a file path. */
export function trackUrl(sessionId: string, track: MediaTrack): string {
  return `${MEDIA_SCHEME}://session/${sessionId}/${track}`
}
