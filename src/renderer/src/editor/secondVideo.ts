import type { EditorSession } from '@shared/models/editor'
import type { EditorStore } from './EditorStore'

/**
 * "Vídeo 2": asks for a video file, lays it from `atMs` on the second video
 * track and splits the screen with the recording at once. Resolves with why
 * it could not, or `null` (done, or the dialog was cancelled).
 */
export async function addSecondVideo(session: EditorSession, store: EditorStore, atMs: number, files: readonly File[] | null = null): Promise<string | null> {
  // Files dropped on the timeline come in as they are; otherwise the user picks one.
  const result = await (files ? window.screenrx.clips.importFiles(session.sessionId, [...files]) : window.screenrx.clips.import(session.sessionId)).catch(() => null)
  if (!result?.ok) return result?.error.message ?? 'Não foi possível trazer o vídeo.'
  const clip = result.value[0]
  if (!clip) return null
  store.setClips([...store.getState().clips, ...result.value])
  let id = ''
  store.runAsOneStep(() => {
    id = store.addVideoLayer(clip.file, atMs)
    store.setLayerSplit(id, true)
  })
  if (id) store.selectLayer(id)
  return null
}
