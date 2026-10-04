/** Scheme under which the main process streams recorded media to the renderers. */
export const MEDIA_SCHEME = 'screenrx-media'

export const MEDIA_TRACKS = ['screen', 'webcam', 'microphone', 'systemAudio'] as const
export type MediaTrack = (typeof MEDIA_TRACKS)[number]

export function isMediaTrack(value: unknown): value is MediaTrack {
  return (MEDIA_TRACKS as readonly unknown[]).includes(value)
}

/** URL of a poster frame of the session's screen track. */
export function thumbnailUrl(sessionId: string): string {
  return `${MEDIA_SCHEME}://session/${sessionId}/thumbnail`
}

/** URL of one of a session's tracks. The renderer never sees a file path. */
export function trackUrl(sessionId: string, track: MediaTrack): string {
  return `${MEDIA_SCHEME}://session/${sessionId}/${track}`
}
