import type { AutoEditChapter, WorkerResult, WorkerRole } from '@shared/models/autoEdit'

/** The order the agents' work is applied in: what shapes the time first, then what sits on it. */
export const ASSEMBLY_ORDER: readonly WorkerRole[] = ['cutter', 'camera', 'captioner', 'sound', 'art']

interface Span {
  startMs: number
  endMs: number
}

const inside = (span: Span, cuts: readonly Span[]): boolean => cuts.some((cut) => cut.startMs <= span.startMs && cut.endMs >= span.endMs)

/**
 * The agents' results in the order they are applied, with what the cuts
 * make pointless taken out: a zoom, a text or a speed region that falls
 * wholly inside a cut (an existing one, or one the cutter is making) is
 * dropped; a chapter title that falls in a cut is moved to the first kept
 * instant after it.
 */
export function assembleWorkers(results: readonly WorkerResult[], existingCuts: readonly Span[], chapters: readonly AutoEditChapter[]): WorkerResult[] {
  const cutter = results.find((result) => result.role === 'cutter')
  const uncuts = cutter?.actions.filter(({ action }) => action.type === 'uncut').map(({ action }) => action as Span) ?? []
  const cuts: Span[] = [
    ...existingCuts.filter((cut) => !uncuts.some((uncut) => uncut.startMs <= cut.startMs && uncut.endMs >= cut.endMs)),
    ...(cutter?.actions.filter(({ action }) => action.type === 'cut').map(({ action }) => action as Span) ?? [])
  ].sort((a, b) => a.startMs - b.startMs)
  const resumeAfter = (timeMs: number): number => {
    let at = timeMs
    for (const cut of cuts) if (cut.startMs <= at && at < cut.endMs) at = cut.endMs
    return at
  }

  return ASSEMBLY_ORDER.flatMap((role) => {
    const result = results.find((candidate) => candidate.role === role)
    if (!result) return []
    if (role === 'cutter') return [result]
    const actions = result.actions.flatMap((entry) => {
      const { action } = entry
      if (action.type === 'zoom' || action.type === 'speed-region') return inside(action, cuts) ? [] : [entry]
      if (action.type === 'text') {
        if (!inside(action, cuts)) return [entry]
        // A title of a chapter is worth keeping: it moves to where the edit resumes.
        const isTitle = chapters.some((chapter) => Math.abs(chapter.startMs - action.startMs) < 1500)
        if (!isTitle) return []
        const startMs = resumeAfter(action.startMs)
        return [{ ...entry, action: { ...action, startMs, endMs: startMs + (action.endMs - action.startMs) } }]
      }
      return [entry]
    })
    return [{ ...result, actions }]
  })
}
