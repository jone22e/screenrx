import { CAPTION_CONFIG } from '@engine/captions/captionConfig'
import { buildCues } from '@engine/captions/captionCues'
import { isExportSpeed } from '@engine/export/exportConfig'
import { addCut, isCoveredByCuts } from '@engine/suggestions/cutSuggestions'
import type { TimeMap } from '@engine/time/timeMapping'
import { buildTimeMap } from '@engine/time/timeMapping'
import { moveSpan, resizeSpan, spanForNew } from '@engine/timeline/spanEditing'
import { TRIM_CONFIG } from '@engine/timeline/trimConfig'
import { regenerateAutoZooms } from '@engine/zoom/autoZoom'
import { MANUAL_ZOOM_DEFAULTS } from '@engine/zoom/zoomConfig'
import type { TimeSpan } from '@engine/zoom/zoomEditing'
import { clampScale, spanForNewZoom } from '@engine/zoom/zoomEditing'
import type { Transcript, TranscriptionRequest, TranscriptionStage } from '@shared/models/captions'
import type { EditorSession } from '@shared/models/editor'
import type { IpcResult } from '@shared/models/errors'
import type {
  BackgroundSettings,
  CaptionCue,
  CaptionLength,
  CaptionSettings,
  CaptionStyle,
  ExportSettings,
  NormalizedPoint,
  Project,
  TrimEffect,
  WebcamSettings,
  ZoomEffect
} from '@shared/models/project'
import {
  BACKGROUND_LIMITS,
  CAPTION_LIMITS,
  WEBCAM_LIMITS,
  isExportFps,
  trimsOf,
  zoomsOf
} from '@shared/models/project'
import type { AiChoice } from '@shared/models/ai'
import type { CutSuggestion, CutSuggestionResult } from '@shared/models/suggestions'

/** Quiet time after the last edit before the project is written to disk. */
const AUTOSAVE_DEBOUNCE_MS = 400
const HISTORY_LIMIT = 200

export type SaveStatus = 'saved' | 'pending' | 'failed'

export interface EditorState {
  /** Zoom regions sorted by start time. */
  zooms: readonly ZoomEffect[]
  /** Cuts sorted by start time. */
  trims: readonly TrimEffect[]
  /** Source ↔ timeline mapping for the current cuts. */
  timeMap: TimeMap
  background: BackgroundSettings
  webcam: WebcamSettings
  captions: CaptionSettings
  exportSettings: ExportSettings
  /** The words the captions are built from; not part of the project. `null` until transcribed. */
  transcript: Transcript | null
  /** UI state: the transcription in progress, if any. */
  transcription: TranscriptionActivity | null
  /** UI state: why the last transcription produced no captions. */
  captionNotice: string | null
  /** UI state: cuts proposed by the AI and not yet decided on. Never part of the project. */
  suggestions: readonly CutSuggestion[]
  /** UI state: whether the AI is being asked for suggestions. */
  suggesting: boolean
  suggestionNotice: string | null
  /** UI state: never persisted. At most one region is selected at a time. */
  selectedZoomId: string | null
  selectedTrimId: string | null
  selectedCueId: string | null
  /** UI state: a stretch of the recording marked on the timeline, e.g. to cut it. */
  selection: TimeSpan | null
  saveStatus: SaveStatus
  canUndo: boolean
  canRedo: boolean
}

export interface TranscriptionActivity {
  stage: TranscriptionStage
  /** How much of the track has been transcribed, 0…1. */
  fraction: number
}

type SaveProject = (project: Project) => Promise<IpcResult<null>>
type Transcribe = (sessionId: string, request: TranscriptionRequest) => Promise<IpcResult<Transcript>>
type SuggestCuts = (sessionId: string, choice: AiChoice) => Promise<IpcResult<CutSuggestionResult>>

const NO_SPEECH_NOTICE = 'Nenhuma fala foi encontrada nesta trilha de áudio.'

const createZoomId = (): string => `zoom-${crypto.randomUUID()}`
const createTrimId = (): string => `trim-${crypto.randomUUID()}`
const createCueId = (): string => `cue-${crypto.randomUUID()}`

/** What is selected on the timeline; at most one of these is set. */
interface Selected {
  zoomId: string | null
  trimId: string | null
  cueId: string | null
}

const NOTHING_SELECTED: Selected = { zoomId: null, trimId: null, cueId: null }

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/**
 * The project being edited. Every edit only changes the description of an
 * effect — the recorded media is never touched — and is saved automatically
 * a moment later. Edits can be undone and redone.
 */
export class EditorStore {
  private project: Project
  private transcript: Transcript | null
  private transcription: TranscriptionActivity | null = null
  private captionNotice: string | null = null
  /** Every suggestion received and not rejected; the pending ones are those no cut covers yet. */
  private allSuggestions: CutSuggestion[] = []
  private suggesting = false
  private suggestionNotice: string | null = null
  private state: EditorState
  private past: Project[] = []
  private future: Project[] = []
  /** Consecutive edits with the same key (a drag, a slider) collapse into one undo step. */
  private gestureKey: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly session: EditorSession,
    private readonly saveProject: SaveProject
  ) {
    this.project = session.project
    this.transcript = session.transcript
    this.state = this.derive(NOTHING_SELECTED, 'saved')
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): EditorState => this.state

  get selectedZoom(): ZoomEffect | null {
    return this.state.zooms.find((zoom) => zoom.id === this.state.selectedZoomId) ?? null
  }

  get selectedTrim(): TrimEffect | null {
    return this.state.trims.find((trim) => trim.id === this.state.selectedTrimId) ?? null
  }

  get selectedCue(): CaptionCue | null {
    return this.state.captions.cues.find((cue) => cue.id === this.state.selectedCueId) ?? null
  }

  select(zoomId: string | null): void {
    this.setSelected({ ...NOTHING_SELECTED, zoomId })
  }

  selectTrim(trimId: string | null): void {
    this.setSelected({ ...NOTHING_SELECTED, trimId })
  }

  selectCue(cueId: string | null): void {
    this.setSelected({ ...NOTHING_SELECTED, cueId })
  }

  private setSelected(selected: Selected): void {
    const { selectedZoomId, selectedTrimId, selectedCueId } = this.state
    if (
      selected.zoomId === selectedZoomId &&
      selected.trimId === selectedTrimId &&
      selected.cueId === selectedCueId
    ) {
      return
    }
    this.state = {
      ...this.state,
      selectedZoomId: selected.zoomId,
      selectedTrimId: selected.trimId,
      selectedCueId: selected.cueId
    }
    this.emit()
  }

  // --- cuts -------------------------------------------------------------------

  /** Cuts out a stretch starting at `timeMs`. Returns whether there was room for it. */
  addTrim(timeMs: number): boolean {
    const span = spanForNew(
      this.state.trims,
      timeMs,
      this.session.durationMs,
      TRIM_CONFIG.defaultDurationMs,
      TRIM_CONFIG.minDurationMs
    )
    if (!span) return false
    const trim: TrimEffect = { id: createTrimId(), type: 'trim', ...span }
    return this.commitTrims([...this.state.trims, trim], trim.id, null)
  }

  /** Marks a stretch of the recording; `null` clears the mark. */
  setSelection(span: TimeSpan | null): void {
    const selection =
      span && {
        startMs: clamp(Math.min(span.startMs, span.endMs), 0, this.session.durationMs),
        endMs: clamp(Math.max(span.startMs, span.endMs), 0, this.session.durationMs)
      }
    this.state = { ...this.state, selection }
    this.emit()
  }

  /** Moves one end of the selection to `timeMs`, starting one when there is none (the I and O keys). */
  markSelection(edge: 'start' | 'end', timeMs: number): void {
    const current = this.state.selection
    const duration = this.session.durationMs
    this.setSelection(
      edge === 'start'
        ? { startMs: timeMs, endMs: current && current.endMs > timeMs ? current.endMs : duration }
        : { startMs: current && current.startMs < timeMs ? current.startMs : 0, endMs: timeMs }
    )
  }

  /**
   * Cuts the selected stretch out of the edit. Cuts it touches are absorbed
   * into one. Returns whether the cut was made.
   */
  cutSelection(): boolean {
    const selection = this.state.selection
    if (!selection || selection.endMs - selection.startMs < TRIM_CONFIG.minDurationMs) return false
    return this.cutSpans([selection])
  }

  // --- suggestions --------------------------------------------------------------

  /**
   * Asks an AI which stretches of speech could go. The answer only becomes a
   * list of proposals: nothing is cut until the user accepts one.
   */
  async suggestCuts(choice: AiChoice, request: SuggestCuts): Promise<void> {
    if (this.suggesting) return
    this.suggesting = true
    this.suggestionNotice = null
    this.refreshSuggestions()
    const result = await request(this.session.sessionId, choice).catch(() => null)
    this.suggesting = false
    if (result?.ok) {
      const { suggestions, analyzedWords, totalWords } = result.value
      this.allSuggestions = suggestions
      this.suggestionNotice =
        suggestions.length === 0
          ? 'A IA não encontrou nada para cortar.'
          : analyzedWords < totalWords
            ? 'A gravação é longa: só o começo da transcrição foi analisado.'
            : null
    } else if (result?.error.code !== 'ai-cancelled') {
      this.suggestionNotice = result?.error.message ?? 'A IA não respondeu como esperado.'
    }
    this.refreshSuggestions()
  }

  /** Makes the suggested cut. It is an ordinary cut from then on, and can be undone. */
  acceptSuggestion(suggestionId: string): boolean {
    const suggestion = this.state.suggestions.find((candidate) => candidate.id === suggestionId)
    return suggestion ? this.cutSpans([suggestion]) : false
  }

  /** Makes every pending suggested cut, as one undo step. */
  acceptAllSuggestions(): boolean {
    const made = this.state.suggestions.length > 0 && this.cutSpans(this.state.suggestions)
    if (!made && this.state.suggestions.length > 0) {
      this.suggestionNotice = 'Aceitar todas não deixaria quase nada da gravação. Aceite uma a uma.'
      this.refreshSuggestions()
    }
    return made
  }

  rejectSuggestion(suggestionId: string): void {
    this.allSuggestions = this.allSuggestions.filter((suggestion) => suggestion.id !== suggestionId)
    this.refreshSuggestions()
  }

  clearSuggestions(): void {
    this.allSuggestions = []
    this.suggestionNotice = null
    this.refreshSuggestions()
  }

  moveTrim(original: TrimEffect, deltaMs: number): void {
    const span = moveSpan(this.state.trims, original, deltaMs, this.session.durationMs)
    this.editTrim(original.id, span)
  }

  resizeTrim(original: TrimEffect, edge: 'start' | 'end', timeMs: number): void {
    const span = resizeSpan(
      this.state.trims,
      original,
      edge,
      timeMs,
      this.session.durationMs,
      TRIM_CONFIG.minDurationMs
    )
    this.editTrim(original.id, span)
  }

  removeTrim(trimId: string): void {
    this.commitTrims(
      this.state.trims.filter((trim) => trim.id !== trimId),
      null,
      null
    )
  }

  // --- export -----------------------------------------------------------------

  /** The global export speed is a setting of its own, not a speed region. */
  setExportSettings(change: Partial<ExportSettings>): void {
    const next = { ...this.project.export, ...change }
    if (!isExportSpeed(next.speed) || !isExportFps(next.fps)) return
    this.commit({ ...this.project, export: next }, this.selected(), null)
  }

  // --- zooms ------------------------------------------------------------------

  /** Adds a zoom at `timeMs`, centred on the frame. Returns whether there was room for it. */
  addZoom(timeMs: number): boolean {
    const span = spanForNewZoom(this.state.zooms, timeMs, this.session.durationMs)
    if (!span) return false
    const zoom: ZoomEffect = {
      id: createZoomId(),
      type: 'zoom',
      ...span,
      focus: { x: 0.5, y: 0.5 },
      scale: MANUAL_ZOOM_DEFAULTS.scale,
      easing: 'easeInOut',
      mode: 'manual'
    }
    this.commitZooms([...this.state.zooms, zoom], zoom.id)
    return true
  }

  setSpan(zoomId: string, span: TimeSpan): void {
    this.editZoom(zoomId, 'span', (zoom) => ({ ...zoom, ...span }))
  }

  setScale(zoomId: string, scale: number): void {
    this.editZoom(zoomId, 'scale', (zoom) => ({ ...zoom, scale: clampScale(scale) }))
  }

  setFocus(zoomId: string, focus: NormalizedPoint): void {
    this.editZoom(zoomId, null, (zoom) => ({
      ...zoom,
      focus: { x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1) }
    }))
  }

  removeZoom(zoomId: string): void {
    this.commitZooms(
      this.state.zooms.filter((zoom) => zoom.id !== zoomId),
      this.state.selectedZoomId === zoomId ? null : this.state.selectedZoomId
    )
  }

  /** Rebuilds the automatic zooms from telemetry; the user's own zooms are kept. */
  regenerateAutoZooms(): void {
    const zooms = regenerateAutoZooms(
      this.state.zooms,
      this.session.interactions,
      this.session.durationMs,
      createZoomId
    )
    const stillSelected = zooms.some((zoom) => zoom.id === this.state.selectedZoomId)
    this.commitZooms(zooms, stillSelected ? this.state.selectedZoomId : null)
  }

  // --- framing ----------------------------------------------------------------

  setBackground(change: Partial<BackgroundSettings>, gestureKey: string | null = null): void {
    const merged = { ...this.project.background, ...change }
    const background: BackgroundSettings = {
      ...merged,
      paddingRatio: clamp(merged.paddingRatio, 0, BACKGROUND_LIMITS.maxPaddingRatio),
      cornerRadiusRatio: clamp(merged.cornerRadiusRatio, 0, BACKGROUND_LIMITS.maxCornerRadiusRatio)
    }
    this.commit({ ...this.project, background }, this.selected(), gestureKey)
  }

  setWebcam(change: Partial<WebcamSettings>, gestureKey: string | null = null): void {
    const merged = { ...this.project.webcam, ...change }
    const webcam: WebcamSettings = {
      ...merged,
      sizeRatio: clamp(merged.sizeRatio, WEBCAM_LIMITS.minSizeRatio, WEBCAM_LIMITS.maxSizeRatio),
      position: { x: clamp(merged.position.x, 0, 1), y: clamp(merged.position.y, 0, 1) }
    }
    this.commit({ ...this.project, webcam }, this.selected(), gestureKey)
  }

  // --- captions ---------------------------------------------------------------

  /**
   * Transcribes an audio track and turns the result into captions. The work
   * happens in the main process; this only tracks it, so the UI can show it
   * from wherever the user is in the editor.
   */
  async generateCaptions(request: TranscriptionRequest, transcribe: Transcribe): Promise<void> {
    if (this.transcription) return
    this.captionNotice = null
    this.setTranscription({ stage: 'preparing', fraction: 0 })
    const result = await transcribe(this.session.sessionId, request).catch(() => null)
    this.transcription = null
    if (result?.ok) {
      if (result.value.words.length === 0) this.captionNotice = NO_SPEECH_NOTICE
      this.applyTranscript(result.value)
      return
    }
    if (result?.error.code !== 'transcription-cancelled') {
      this.captionNotice = result?.error.message ?? 'Não foi possível transcrever o áudio desta gravação.'
    }
    this.state = { ...this.state, transcription: null, captionNotice: this.captionNotice }
    this.emit()
  }

  /** Progress reported by the transcriber; ignored when nothing is being transcribed. */
  setTranscription(activity: TranscriptionActivity): void {
    if (this.transcription && activity.fraction < this.transcription.fraction) return
    this.transcription = activity
    this.state = { ...this.state, transcription: activity, captionNotice: this.captionNotice }
    this.emit()
  }

  get transcribing(): boolean {
    return this.transcription !== null
  }

  /**
   * Takes a fresh transcript and builds the captions from it. The transcript
   * itself is derived data and is not undoable; the captions are.
   */
  applyTranscript(transcript: Transcript): void {
    this.transcript = transcript
    this.commitCaptions(
      { ...this.project.captions, visible: true, cues: this.cuesFor(this.project.captions.length) },
      null,
      null
    )
  }

  /** Changes how much text goes into each caption, rebuilding them from the transcript. */
  setCaptionLength(length: CaptionLength): void {
    const cues = this.transcript ? this.cuesFor(length) : this.project.captions.cues
    this.commitCaptions({ ...this.project.captions, length, cues }, null, null)
  }

  /** Builds the captions again from the transcript, discarding edits made to them. */
  rebuildCaptions(): void {
    if (!this.transcript) return
    this.commitCaptions(
      { ...this.project.captions, visible: true, cues: this.cuesFor(this.project.captions.length) },
      null,
      null
    )
  }

  removeCaptions(): void {
    this.commitCaptions({ ...this.project.captions, cues: [] }, null, null)
  }

  setCaptionsVisible(visible: boolean): void {
    this.commitCaptions({ ...this.project.captions, visible }, null, this.state.selectedCueId)
  }

  setCaptionStyle(change: Partial<CaptionStyle>, gestureKey: string | null = null): void {
    const merged = { ...this.project.captions.style, ...change }
    const style: CaptionStyle = {
      ...merged,
      sizeRatio: clamp(merged.sizeRatio, CAPTION_LIMITS.minSizeRatio, CAPTION_LIMITS.maxSizeRatio),
      position: { x: clamp(merged.position.x, 0, 1), y: clamp(merged.position.y, 0, 1) }
    }
    this.commitCaptions({ ...this.project.captions, style }, gestureKey, this.state.selectedCueId)
  }

  setCueText(cueId: string, text: string): void {
    this.editCue(cueId, 'cue-text', (cue) => ({ ...cue, text: text.slice(0, CAPTION_LIMITS.maxTextLength) }))
  }

  moveCue(original: CaptionCue, deltaMs: number): void {
    const span = moveSpan(this.state.captions.cues, original, deltaMs, this.session.durationMs)
    this.editCue(original.id, 'cue-span', (cue) => ({ ...cue, ...span }))
  }

  resizeCue(original: CaptionCue, edge: 'start' | 'end', timeMs: number): void {
    const span = resizeSpan(
      this.state.captions.cues,
      original,
      edge,
      timeMs,
      this.session.durationMs,
      CAPTION_CONFIG.minCueDurationMs
    )
    this.editCue(original.id, 'cue-span', (cue) => ({ ...cue, ...span }))
  }

  removeCue(cueId: string): void {
    const cues = this.project.captions.cues.filter((cue) => cue.id !== cueId)
    this.commitCaptions(
      { ...this.project.captions, cues },
      null,
      this.state.selectedCueId === cueId ? null : this.state.selectedCueId
    )
  }

  // --- history ----------------------------------------------------------------

  /** Ends a drag or slider gesture, so the next edit starts a new undo step. */
  endGesture(): void {
    this.gestureKey = null
  }

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(this.project)
    this.restore(previous)
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.project)
    this.restore(next)
  }

  /** The project as it stands, for rendering an export of exactly what is on screen. */
  snapshot(): Project {
    return this.project
  }

  /** Writes any pending edit right away (e.g. when leaving the editor). */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.persist()
    }
    await this.saving
  }

  // --- internals --------------------------------------------------------------

  /** Cuts `spans` out of the edit in one step. Cuts they touch are absorbed. */
  private cutSpans(spans: readonly TimeSpan[]): boolean {
    const existing = this.state.trims
    let merged: TimeSpan[] = [...existing]
    for (const span of spans) merged = addCut(merged, span)
    const trims = merged.map(
      (span): TrimEffect =>
        existing.find((trim) => trim.startMs === span.startMs && trim.endMs === span.endMs) ?? {
          id: createTrimId(),
          type: 'trim',
          startMs: span.startMs,
          endMs: span.endMs
        }
    )
    const last = spans[spans.length - 1]
    const made = last && trims.find((trim) => trim.startMs <= last.startMs && trim.endMs >= last.endMs)
    return this.commitTrims(trims, made?.id ?? null, null)
  }

  private pendingSuggestions(): CutSuggestion[] {
    const trims = trimsOf(this.project)
    return this.allSuggestions.filter((suggestion) => !isCoveredByCuts(suggestion, trims))
  }

  private refreshSuggestions(): void {
    this.state = {
      ...this.state,
      suggestions: this.pendingSuggestions(),
      suggesting: this.suggesting,
      suggestionNotice: this.suggestionNotice
    }
    this.emit()
  }

  private editTrim(trimId: string, span: TimeSpan): void {
    this.commitTrims(
      this.state.trims.map((trim) => (trim.id === trimId ? { ...trim, ...span } : trim)),
      trimId,
      `trim:${trimId}`
    )
  }

  /** Applies a change to the cuts, unless it would leave (almost) nothing of the recording. */
  private commitTrims(trims: readonly TrimEffect[], selectedTrimId: string | null, gestureKey: string | null): boolean {
    const others = this.project.effects.filter((effect) => effect.type !== 'trim')
    const effects = [...others, ...[...trims].sort((a, b) => a.startMs - b.startMs)]
    const kept = buildTimeMap(this.session.durationMs, effects).timelineDurationMs
    if (kept < Math.min(TRIM_CONFIG.minKeptDurationMs, this.session.durationMs)) return false
    this.commit({ ...this.project, effects }, { ...NOTHING_SELECTED, trimId: selectedTrimId }, gestureKey)
    return true
  }

  /** A zoom the user touches becomes theirs: regeneration will not replace it. */
  private editZoom(zoomId: string, gesture: string | null, change: (zoom: ZoomEffect) => ZoomEffect): void {
    this.commitZooms(
      this.state.zooms.map((zoom) =>
        zoom.id === zoomId ? { ...change(zoom), mode: 'manual' as const } : zoom
      ),
      this.state.selectedZoomId,
      gesture && `${gesture}:${zoomId}`
    )
  }

  private commitZooms(
    zooms: readonly ZoomEffect[],
    selectedZoomId: string | null,
    gestureKey: string | null = null
  ): void {
    const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs)
    const others = this.project.effects.filter((effect) => effect.type !== 'zoom')
    this.commit(
      { ...this.project, effects: [...others, ...sorted] },
      { ...NOTHING_SELECTED, zoomId: selectedZoomId },
      gestureKey
    )
  }

  private cuesFor(length: CaptionLength): CaptionCue[] {
    if (!this.transcript) return []
    // An audio track can run a little past the screen track; captions cannot.
    const durationMs = this.session.durationMs
    return buildCues(this.transcript.words, length, createCueId)
      .filter((cue) => cue.startMs < durationMs)
      .map((cue) => (cue.endMs > durationMs ? { ...cue, endMs: durationMs } : cue))
  }

  private editCue(cueId: string, gesture: string, change: (cue: CaptionCue) => CaptionCue): void {
    const cues = this.project.captions.cues.map((cue) => (cue.id === cueId ? change(cue) : cue))
    this.commitCaptions({ ...this.project.captions, cues }, `${gesture}:${cueId}`, cueId)
  }

  private commitCaptions(captions: CaptionSettings, gestureKey: string | null, selectedCueId: string | null): void {
    this.commit({ ...this.project, captions }, { ...NOTHING_SELECTED, cueId: selectedCueId }, gestureKey)
  }

  /** The selection an edit of the look (framing, webcam, export) leaves in place. */
  private selected(): Selected {
    return { zoomId: this.state.selectedZoomId, trimId: null, cueId: this.state.selectedCueId }
  }

  private commit(project: Project, selected: Selected, gestureKey: string | null): void {
    const continuesGesture = gestureKey !== null && gestureKey === this.gestureKey
    if (!continuesGesture) {
      this.past.push(this.project)
      if (this.past.length > HISTORY_LIMIT) this.past.shift()
    }
    this.future = []
    this.gestureKey = gestureKey
    this.project = project
    // A cut consumes the selection it was made from; other edits leave it alone.
    const selection = selected.trimId !== null && gestureKey === null ? null : this.state.selection
    this.state = { ...this.derive(selected, 'pending'), selection }
    this.emit()
    this.scheduleSave()
  }

  private restore(project: Project): void {
    this.gestureKey = null
    this.project = project
    const zoomExists = zoomsOf(project).some((zoom) => zoom.id === this.state.selectedZoomId)
    const trimExists = trimsOf(project).some((trim) => trim.id === this.state.selectedTrimId)
    const cueExists = project.captions.cues.some((cue) => cue.id === this.state.selectedCueId)
    this.state = {
      ...this.derive(
        {
          zoomId: zoomExists ? this.state.selectedZoomId : null,
          trimId: trimExists ? this.state.selectedTrimId : null,
          cueId: cueExists ? this.state.selectedCueId : null
        },
        'pending'
      ),
      selection: this.state.selection
    }
    this.emit()
    this.scheduleSave()
  }

  private derive(selected: Selected, saveStatus: SaveStatus): EditorState {
    return {
      zooms: zoomsOf(this.project),
      trims: trimsOf(this.project),
      timeMap: buildTimeMap(this.session.durationMs, this.project.effects),
      background: this.project.background,
      webcam: this.project.webcam,
      captions: this.project.captions,
      exportSettings: this.project.export,
      transcript: this.transcript,
      transcription: this.transcription,
      captionNotice: this.captionNotice,
      suggestions: this.pendingSuggestions(),
      suggesting: this.suggesting,
      suggestionNotice: this.suggestionNotice,
      selectedZoomId: selected.zoomId,
      selectedTrimId: selected.trimId,
      selectedCueId: selected.cueId,
      selection: null,
      saveStatus,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persist()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  private persist(): void {
    const snapshot = this.project
    // Saves are chained so an older snapshot can never land after a newer one.
    this.saving = this.saving.then(async () => {
      const result = await this.saveProject(snapshot).catch(() => ({ ok: false as const }))
      if (snapshot !== this.project) return
      this.state = { ...this.state, saveStatus: result.ok ? 'saved' : 'failed' }
      this.emit()
    })
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
