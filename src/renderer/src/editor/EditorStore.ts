import { CAPTION_CONFIG } from '@engine/captions/captionConfig'
import { buildCues, cueText } from '@engine/captions/captionCues'
import { buildDubUnits, pickVoiceReference } from '@engine/dub/dubUnits'
import { isExportSpeed } from '@engine/export/exportConfig'
import { addCut, isCoveredByCuts } from '@engine/suggestions/cutSuggestions'
import type { TimeMap } from '@engine/time/timeMapping'
import { buildTimeMap } from '@engine/time/timeMapping'
import { moveSpan, resizeSpan, spanForNew } from '@engine/timeline/spanEditing'
import { TRIM_CONFIG } from '@engine/timeline/trimConfig'
import { regenerateAutoZooms } from '@engine/zoom/autoZoom'
import { MANUAL_ZOOM_DEFAULTS, ZOOM_LIMITS } from '@engine/zoom/zoomConfig'
import type { TimeSpan } from '@engine/zoom/zoomEditing'
import { clampScale, spanForNewZoom } from '@engine/zoom/zoomEditing'
import type { Transcript, TranscriptionRequest, TranscriptionStage } from '@shared/models/captions'
import type { DubProgress, DubRequest, DubTrack } from '@shared/models/dub'
import type { ColorSettings, FilterRenderRequest, FilterSettings, FilterTrack, RenderedFilter, RenderedFilterName } from '@shared/models/filters'
import { COLOR_LIMITS, DEFAULT_COLOR, needsRenderedTrack, renderKey } from '@shared/models/filters'
import type { ObjectTrack, ObjectTrackRequest } from '@shared/models/telemetry'
import type { EditorSession } from '@shared/models/editor'
import type { IpcResult } from '@shared/models/errors'
import type {
  AudioSettings,
  AudioTrackKind,
  BackgroundSettings,
  CaptionCue,
  CaptionLanguage,
  CaptionLength,
  CaptionSettings,
  CaptionStyle,
  DubSettings,
  ExportSettings,
  NormalizedPoint,
  Project,
  TextOverlay,
  TrimEffect,
  WebcamSettings,
  ZoomEffect
} from '@shared/models/project'
import {
  BACKGROUND_LIMITS,
  CAPTION_LIMITS,
  DEFAULT_TEXT_STYLE,
  TEXT_LIMITS,
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
  /** Texts written over the video, sorted by start. */
  texts: readonly TextOverlay[]
  audio: AudioSettings
  /** Which dubbing is heard instead of the recorded voice. */
  dub: DubSettings
  /** The dubbing tracks that exist for this recording; not part of the project. */
  dubs: readonly DubTrack[]
  /** Where an object marked in the video goes, when one was tracked; not part of the project. */
  objectTrack: ObjectTrack | null
  /** UI state: the tracking in progress, if any, 0…1. */
  tracking: { fraction: number } | null
  trackNotice: string | null
  /** UI state: the user is drawing the object to track on the preview. */
  markingObject: boolean
  /** UI state: the dubbing being generated, if any. */
  dubbing: (DubProgress & { language: CaptionLanguage }) | null
  dubNotice: string | null
  /** Effects on the picture. */
  filters: FilterSettings
  /** The rendered-effects track on disk and what it was made from; not part of the project. */
  filterTrack: FilterTrack | null
  /** UI state: the rendering in progress, if any, 0…1. */
  filtering: { fraction: number } | null
  filterNotice: string | null
  /** The screen track the preview shows: the recording, or the rendered-effects track when it is in use and current. */
  screenUrl: string
  /** Which picture an object is tracked in, so the track matches what is shown. */
  trackingSource: 'screen' | 'screenFx'
  exportSettings: ExportSettings
  /** The words the captions are built from; not part of the project. `null` until transcribed. */
  transcript: Transcript | null
  /** UI state: the transcription in progress, if any. */
  transcription: TranscriptionActivity | null
  /** UI state: why the last transcription produced no captions. */
  captionNotice: string | null
  /** UI state: the language captions are being translated into, if any. */
  translating: CaptionLanguage | null
  /** UI state: cuts proposed by the AI and not yet decided on. Never part of the project. */
  suggestions: readonly CutSuggestion[]
  /** UI state: whether the AI is being asked for suggestions. */
  suggesting: boolean
  suggestionNotice: string | null
  /** UI state: never persisted. At most one region is selected at a time. */
  selectedZoomId: string | null
  selectedTrimId: string | null
  selectedCueId: string | null
  selectedTextId: string | null
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
type TranslateCaptions = (
  language: CaptionLanguage,
  cues: Array<{ id: string; text: string }>,
  sourceLocale: string
) => Promise<IpcResult<Record<string, string>>>
type GenerateDub = (sessionId: string, request: DubRequest) => Promise<IpcResult<DubTrack>>
type RenderFilters = (sessionId: string, request: FilterRenderRequest) => Promise<IpcResult<FilterTrack>>
type SuggestCuts = (sessionId: string, choice: AiChoice) => Promise<IpcResult<CutSuggestionResult>>

const NO_SPEECH_NOTICE = 'Nenhuma fala foi encontrada nesta trilha de áudio.'

const createZoomId = (): string => `zoom-${crypto.randomUUID()}`
const createTrimId = (): string => `trim-${crypto.randomUUID()}`
const createCueId = (): string => `cue-${crypto.randomUUID()}`
const createTextId = (): string => `text-${crypto.randomUUID()}`

/** What is selected on the timeline; at most one of these is set. */
interface Selected {
  zoomId: string | null
  trimId: string | null
  cueId: string | null
  textId: string | null
}

const NOTHING_SELECTED: Selected = { zoomId: null, trimId: null, cueId: null, textId: null }

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/**
 * The project being edited. Every edit only changes the description of an
 * effect — the recorded media is never touched — and is saved automatically
 * a moment later. Edits can be undone and redone.
 */
/** Marking this close to the end of the recording leaves no frame to track. */
const LAST_FRAME_GRACE_MS = 100
const END_OF_VIDEO_NOTICE =
  'Esse instante é o fim do vídeo e não há o que rastrear depois dele. Vá até o momento em que o objeto aparece e marque de novo.'

/** What to tell the user when the tracker could not follow the object. */
function trackingNotice(error: { message: string; detail?: string } | null): string {
  const detail = error?.detail ?? ''
  if (detail.includes('not seen')) return 'O objeto não foi reconhecido. Marque um retângulo mais justo em volta dele.'
  if (detail.includes('nothing to track')) return END_OF_VIDEO_NOTICE
  if (detail.includes('bounding box size')) {
    return 'O rastreador não aceitou esse retângulo. Marque um retângulo menor, só em volta do objeto, e tente de novo.'
  }
  return error?.message ?? 'Não foi possível rastrear o objeto.'
}

export class EditorStore {
  private project: Project
  private transcript: Transcript | null
  private transcription: TranscriptionActivity | null = null
  private captionNotice: string | null = null
  private translating: CaptionLanguage | null = null
  private dubs: DubTrack[]
  private objectTrack: ObjectTrack | null
  private tracking: { fraction: number } | null = null
  private trackNotice: string | null = null
  private markingObject = false
  private dubbing: (DubProgress & { language: CaptionLanguage }) | null = null
  private dubNotice: string | null = null
  private filterTrack: FilterTrack | null
  private filtering: { fraction: number } | null = null
  private filterNotice: string | null = null
  /** The rendering under way: what it is making, and when it is over. */
  private filterRun: { key: string; promise: Promise<void> } | null = null
  /** Every suggestion received and not rejected; the pending ones are those no cut covers yet. */
  private allSuggestions: CutSuggestion[] = []
  private suggesting = false
  private suggestionNotice: string | null = null
  private state: EditorState
  private past: Project[] = []
  private future: Project[] = []
  /** Consecutive edits with the same key (a drag, a slider) collapse into one undo step. */
  private gestureKey: string | null = null
  /** While a batch runs, every edit goes into the undo step the first one opened. */
  private batch: { opened: boolean } | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly session: EditorSession,
    private readonly saveProject: SaveProject
  ) {
    this.project = session.project
    this.transcript = session.transcript
    this.dubs = [...session.dubs]
    this.filterTrack = session.filterTrack
    this.objectTrack = session.track
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

  get selectedText(): TextOverlay | null {
    return this.state.texts.find((text) => text.id === this.state.selectedTextId) ?? null
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

  selectText(textId: string | null): void {
    this.setSelected({ ...NOTHING_SELECTED, textId })
  }

  private setSelected(selected: Selected): void {
    const { selectedZoomId, selectedTrimId, selectedCueId, selectedTextId } = this.state
    if (
      selected.zoomId === selectedZoomId &&
      selected.trimId === selectedTrimId &&
      selected.cueId === selectedCueId &&
      selected.textId === selectedTextId
    ) {
      return
    }
    this.state = {
      ...this.state,
      selectedZoomId: selected.zoomId,
      selectedTrimId: selected.trimId,
      selectedCueId: selected.cueId,
      selectedTextId: selected.textId
    }
    this.emit()
  }

  // --- texts --------------------------------------------------------------------

  /** Writes a text over the video from `timeMs`, for a few seconds, and selects it. Returns its id. */
  addText(timeMs: number, content = 'Seu texto', style: CaptionStyle = DEFAULT_TEXT_STYLE): string {
    const startMs = clamp(timeMs, 0, Math.max(0, this.session.durationMs - TEXT_LIMITS.minDurationMs))
    return this.addTextSpan({ startMs, endMs: startMs + TEXT_LIMITS.defaultDurationMs }, content, style)
  }

  /** Writes a text over the video during `span`. Returns its id. */
  addTextSpan(span: TimeSpan, content: string, style: CaptionStyle = DEFAULT_TEXT_STYLE): string {
    const startMs = clamp(span.startMs, 0, this.session.durationMs)
    const endMs = clamp(Math.max(span.endMs, startMs + TEXT_LIMITS.minDurationMs), 0, this.session.durationMs)
    const text: TextOverlay = {
      id: createTextId(),
      startMs,
      endMs: Math.max(endMs, Math.min(startMs + TEXT_LIMITS.minDurationMs, this.session.durationMs)),
      text: content.slice(0, TEXT_LIMITS.maxTextLength),
      style: { ...style, position: { ...style.position } }
    }
    this.commitTexts([...this.project.texts, text], text.id, null)
    return text.id
  }

  setTextContent(textId: string, content: string): void {
    const clipped = content.slice(0, TEXT_LIMITS.maxTextLength)
    this.editText(textId, `text-content:${textId}`, (text) => ({ ...text, text: clipped }))
  }

  setTextStyle(textId: string, change: Partial<CaptionStyle>, gestureKey: string | null = null): void {
    this.editText(textId, gestureKey === null ? null : `${gestureKey}:${textId}`, (text) => {
      const merged = { ...text.style, ...change }
      return {
        ...text,
        style: {
          ...merged,
          sizeRatio: clamp(merged.sizeRatio, CAPTION_LIMITS.minSizeRatio, CAPTION_LIMITS.maxSizeRatio),
          position: { x: clamp(merged.position.x, 0, 1), y: clamp(merged.position.y, 0, 1) }
        }
      }
    })
  }

  /** Slides a text in time, keeping its length within the recording. Texts may overlap. */
  moveText(original: TextOverlay, deltaMs: number): void {
    const length = original.endMs - original.startMs
    const startMs = clamp(original.startMs + deltaMs, 0, Math.max(0, this.session.durationMs - length))
    this.editText(original.id, `text-span:${original.id}`, (text) => ({ ...text, startMs, endMs: startMs + length }))
  }

  resizeText(original: TextOverlay, edge: 'start' | 'end', timeMs: number): void {
    const span =
      edge === 'start'
        ? { startMs: clamp(timeMs, 0, original.endMs - TEXT_LIMITS.minDurationMs), endMs: original.endMs }
        : { startMs: original.startMs, endMs: clamp(timeMs, original.startMs + TEXT_LIMITS.minDurationMs, this.session.durationMs) }
    this.editText(original.id, `text-span:${original.id}`, (text) => ({ ...text, ...span }))
  }

  removeText(textId: string): void {
    this.commitTexts(
      this.project.texts.filter((text) => text.id !== textId),
      this.state.selectedTextId === textId ? null : this.state.selectedTextId,
      null
    )
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

  /** Cuts a stretch out of the edit, as `cutSelection` does for the selected one. */
  cutStretch(span: TimeSpan): boolean {
    if (span.endMs - span.startMs < TRIM_CONFIG.minDurationMs) return false
    return this.cutSpans([span])
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

  /** Adds a zoom over exactly `span`, unless a zoom is already there. Returns whether it was added. */
  addZoomSpan(span: TimeSpan, scale: number | null): boolean {
    const startMs = clamp(span.startMs, 0, this.session.durationMs)
    const endMs = clamp(span.endMs, 0, this.session.durationMs)
    if (endMs - startMs < ZOOM_LIMITS.minDurationMs) return false
    if (this.state.zooms.some((zoom) => zoom.startMs < endMs && zoom.endMs > startMs)) return false
    const zoom: ZoomEffect = {
      id: createZoomId(),
      type: 'zoom',
      startMs,
      endMs,
      focus: { x: 0.5, y: 0.5 },
      scale: clampScale(scale ?? MANUAL_ZOOM_DEFAULTS.scale),
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
      crop: { x: clamp(merged.crop.x, 0, 1), y: clamp(merged.crop.y, 0, 1) },
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
    this.commitCaptions(this.withNewCues(this.cuesFor(this.project.captions.length), { visible: true }), null, null)
  }

  /** Changes how much text goes into each caption, rebuilding them from the transcript. */
  setCaptionLength(length: CaptionLength): void {
    if (!this.transcript) {
      this.commitCaptions({ ...this.project.captions, length }, null, null)
      return
    }
    this.commitCaptions(this.withNewCues(this.cuesFor(length), { length }), null, null)
  }

  /** Builds the captions again from the transcript, discarding edits made to them. */
  rebuildCaptions(): void {
    if (!this.transcript) return
    this.commitCaptions(this.withNewCues(this.cuesFor(this.project.captions.length), { visible: true }), null, null)
  }

  removeCaptions(): void {
    this.commitCaptions(this.withNewCues([], {}), null, null)
  }

  /**
   * Shows the captions in `language` (`null`: as spoken). A language that has
   * not been translated yet cannot be shown: translate it first.
   */
  setCaptionLanguage(language: CaptionLanguage | null): boolean {
    if (language !== null && !this.project.captions.translations[language]) return false
    this.commitCaptions({ ...this.project.captions, language }, null, this.state.selectedCueId)
    return true
  }

  /**
   * Translates every caption into `language` and shows the result. The
   * translation is done elsewhere (by an AI, through the main process); the
   * text it returns becomes part of the project and can be corrected like
   * any caption.
   */
  async translateCaptions(language: CaptionLanguage, translate: TranslateCaptions, show = true): Promise<void> {
    if (this.translating || this.project.captions.cues.length === 0) return
    const cues = this.project.captions.cues.map(({ id, text }) => ({ id, text }))
    this.translating = language
    this.captionNotice = null
    this.refreshCaptionActivity()
    const result = await translate(language, cues, this.transcript?.locale ?? 'pt-BR').catch(() => null)
    this.translating = null
    if (result?.ok) {
      // Captions may have changed while the translation was on its way: only those still here get it.
      const current = this.project.captions
      const texts: Record<string, string> = {}
      for (const cue of current.cues) {
        const text = result.value[cue.id]
        if (text !== undefined) texts[cue.id] = text
      }
      if (Object.keys(texts).length === 0) {
        this.captionNotice = 'A IA não devolveu nenhuma tradução. Tente de novo.'
      } else {
        if (Object.keys(texts).length < current.cues.length) {
          this.captionNotice = 'Algumas legendas ficaram sem tradução e aparecem no idioma original.'
        }
        // `show` is false when the translation is only needed to dub: the captions on screen stay as they are.
        this.commitCaptions(
          {
            ...current,
            language: show ? language : current.language,
            translations: { ...current.translations, [language]: texts }
          },
          null,
          this.state.selectedCueId
        )
        return
      }
    } else if (result?.error.code !== 'ai-cancelled') {
      this.captionNotice = result?.error.message ?? 'Não foi possível traduzir as legendas.'
    }
    this.refreshCaptionActivity()
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

  /** Corrects a caption's text, in the language being shown. */
  setCueText(cueId: string, text: string): void {
    const clipped = text.slice(0, CAPTION_LIMITS.maxTextLength)
    const { language, translations } = this.project.captions
    if (language === null) {
      this.editCue(cueId, 'cue-text', (cue) => ({ ...cue, text: clipped }))
      return
    }
    this.commitCaptions(
      {
        ...this.project.captions,
        translations: { ...translations, [language]: { ...translations[language], [cueId]: clipped } }
      },
      `cue-text:${language}:${cueId}`,
      cueId
    )
  }

  /** The text a caption shows in the language chosen. */
  textOf(cue: CaptionCue): string {
    return cueText(this.project.captions, cue)
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

  // --- dubbing ----------------------------------------------------------------

  /**
   * Speaks the captions in `language` with the speaker's own voice and puts
   * the result to use. The captions must already be translated into that
   * language; the voice is learned from the first seconds of the microphone
   * track. The work is done by the main process and its native helper.
   */
  async generateDub(language: CaptionLanguage, generate: GenerateDub): Promise<void> {
    if (this.dubbing) return
    const { captions } = this.project
    const texts = captions.translations[language]
    const reference =
      this.transcript?.track === 'microphone' ? pickVoiceReference(this.transcript.words) : null
    if (!texts) {
      this.dubNotice = 'Traduza as legendas para este idioma antes de dublar.'
    } else if (!reference) {
      this.dubNotice =
        'A voz é aprendida do microfone: a gravação precisa de alguns segundos de fala transcritos a partir dele.'
    } else {
      this.dubNotice = null
    }
    if (!texts || !reference) {
      this.refreshDub()
      return
    }

    const units = buildDubUnits(
      captions.cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: texts[cue.id] ?? '' })),
      this.session.durationMs
    )
    if (units.length === 0) {
      this.dubNotice = 'Não há texto para dublar.'
      this.refreshDub()
      return
    }

    this.dubbing = { language, stage: 'loading', fraction: 0 }
    this.refreshDub()
    const result = await generate(this.session.sessionId, { language, units, reference }).catch(() => null)
    this.dubbing = null
    if (result?.ok) {
      // The track's address does not change when it is generated again: the stamp makes players reload it.
      const track = { language, url: `${result.value.url}?v=${Date.now()}` }
      this.dubs = [...this.dubs.filter((dub) => dub.language !== language), track]
      this.commit({ ...this.project, dub: { language } }, this.selected(), null)
      return
    }
    if (result?.error.code !== 'dub-cancelled') {
      this.dubNotice = result?.error.message ?? 'Não foi possível gerar a dublagem.'
    }
    this.refreshDub()
  }

  /**
   * Dubs the recording into `language` in one step: the text is translated
   * first when it has not been yet — without changing the captions on screen,
   * which are a separate matter — and then spoken.
   */
  async dubInto(language: CaptionLanguage, translate: TranslateCaptions | null, generate: GenerateDub): Promise<void> {
    if (this.dubbing || this.translating) return
    if (this.project.captions.cues.length === 0) {
      this.dubNotice = 'A dublagem parte do que foi falado: gere as legendas primeiro, na aba Legendas.'
      this.refreshDub()
      return
    }
    if (!this.project.captions.translations[language]) {
      if (!translate) {
        this.dubNotice = 'A tradução do texto é feita por uma ferramenta de IA, e nenhuma está pronta neste Mac.'
        this.refreshDub()
        return
      }
      this.dubNotice = null
      this.refreshDub()
      await this.translateCaptions(language, translate, false)
      if (!this.project.captions.translations[language]) {
        // The reason is the translation's; it is shown where the user asked for the dubbing.
        this.dubNotice = this.captionNotice ?? 'Não foi possível traduzir o texto para dublar.'
        this.refreshDub()
        return
      }
    }
    await this.generateDub(language, generate)
  }

  /** Progress reported while a dubbing is being generated. */
  // --- object tracking ------------------------------------------------------------

  /** Whether the preview is in marking mode, where a drag draws the object to follow. */
  setMarkingObject(marking: boolean): void {
    if (this.markingObject === marking) return
    this.markingObject = marking
    this.refreshTracking()
  }

  /**
   * Follows the marked object from `request.startMs` on. The work is done
   * elsewhere (the native tracker, through the main process); the track it
   * returns is kept with the session and drives the frame that follows it.
   */
  async startObjectTracking(
    request: ObjectTrackRequest,
    track: (sessionId: string, request: ObjectTrackRequest) => Promise<IpcResult<ObjectTrack>>
  ): Promise<void> {
    if (this.tracking) return
    this.markingObject = false
    this.trackNotice = null
    // Tracking goes forward from the marked instant: at the very end there is nothing to follow.
    if (request.startMs >= this.session.durationMs - LAST_FRAME_GRACE_MS) {
      this.trackNotice = END_OF_VIDEO_NOTICE
      this.refreshTracking()
      return
    }
    this.tracking = { fraction: 0 }
    this.refreshTracking()
    const result = await track(this.session.sessionId, request).catch(() => null)
    this.tracking = null
    if (result?.ok) {
      this.objectTrack = result.value
    } else if (result?.error.detail?.includes('cancelled')) {
      this.trackNotice = null
    } else {
      this.trackNotice = trackingNotice(result?.error ?? null)
    }
    this.refreshTracking()
  }

  setTrackProgress(fraction: number): void {
    if (!this.tracking) return
    this.tracking = { fraction }
    this.refreshTracking()
  }

  get trackingObject(): boolean {
    return this.tracking !== null
  }

  private refreshTracking(): void {
    this.state = {
      ...this.state,
      objectTrack: this.objectTrack,
      tracking: this.tracking,
      trackNotice: this.trackNotice,
      markingObject: this.markingObject
    }
    this.emit()
  }

  // --- effects ----------------------------------------------------------------

  /** Turns one of the rendered effects on or off, or changes its strength. */
  setRenderedFilter(name: RenderedFilterName, change: Partial<RenderedFilter>): void {
    const filters = { ...this.project.filters, [name]: { ...this.project.filters[name], ...change } }
    this.commit({ ...this.project, filters }, this.selected(), null)
  }

  setColor(change: Partial<ColorSettings>, gestureKey: string | null = null): void {
    const merged = { ...this.project.filters.color, ...change }
    const color: ColorSettings = {
      brightness: clamp(merged.brightness, COLOR_LIMITS.brightness.min, COLOR_LIMITS.brightness.max),
      contrast: clamp(merged.contrast, COLOR_LIMITS.contrast.min, COLOR_LIMITS.contrast.max),
      saturation: clamp(merged.saturation, COLOR_LIMITS.saturation.min, COLOR_LIMITS.saturation.max)
    }
    this.commit({ ...this.project, filters: { ...this.project.filters, color } }, this.selected(), gestureKey)
  }

  resetColor(): void {
    this.setColor({ ...DEFAULT_COLOR })
  }

  /** The screen track to show: the rendered one when it is wanted and matches the settings. */
  private screenUrl(): string {
    const { filters } = this.project
    return needsRenderedTrack(filters) && this.filterTrack?.key === renderKey(filters)
      ? this.filterTrack.url
      : this.session.video.url
  }

  /**
   * Keeps the rendered-effects track in step with the settings: renders it
   * when the settings ask for effects the track does not have yet, and
   * stops a rendering that no longer matches. Called whenever the project
   * changes; it is a no-op when nothing has to be done.
   */
  async renderFilters(render: RenderFilters, cancel: () => void): Promise<void> {
    const { filters } = this.project
    const key = renderKey(filters)
    const wanted = needsRenderedTrack(filters) && this.filterTrack?.key !== key
    if (this.filterRun) {
      if (this.filterRun.key === key && wanted) return
      // Something else is wanted now: let the old rendering go.
      cancel()
      await this.filterRun.promise
      if (renderKey(this.project.filters) !== key) return
    }
    if (!wanted) return
    const request: FilterRenderRequest = {
      stabilization: filters.stabilization,
      denoise: filters.denoise,
      sharpen: filters.sharpen
    }
    this.filtering = { fraction: 0 }
    this.filterNotice = null
    this.refreshFilters()
    const promise = render(this.session.sessionId, request).then(
      (result) => {
        if (result.ok) {
          // The track's address does not change when it is rendered again: the stamp makes the player reload it.
          this.filterTrack = { url: `${result.value.url}?v=${Date.now()}`, key: result.value.key }
        } else if (result.error.code !== 'filters-cancelled') {
          this.filterNotice = result.error.message
        }
      },
      () => {
        this.filterNotice = 'Não foi possível aplicar os efeitos ao vídeo.'
      }
    )
    const run = { key, promise }
    this.filterRun = run
    await promise
    if (this.filterRun === run) {
      this.filterRun = null
      this.filtering = null
    }
    this.refreshFilters()
  }

  setFilterProgress(fraction: number): void {
    if (!this.filtering) return
    this.filtering = { fraction }
    this.refreshFilters()
  }

  private refreshFilters(): void {
    this.state = {
      ...this.state,
      filterTrack: this.filterTrack,
      filtering: this.filtering,
      filterNotice: this.filterNotice,
      screenUrl: this.screenUrl(),
      trackingSource: this.screenUrl() === this.session.video.url ? 'screen' : 'screenFx'
    }
    this.emit()
  }

  setDubProgress(progress: DubProgress): void {
    if (!this.dubbing) return
    this.dubbing = { ...this.dubbing, ...progress }
    this.refreshDub()
  }

  /** Chooses which dubbing is heard (`null`: the voice as recorded). */
  setDubLanguage(language: CaptionLanguage | null): void {
    if (language !== null && !this.dubs.some((dub) => dub.language === language)) return
    this.commit({ ...this.project, dub: { language } }, this.selected(), null)
  }

  private refreshDub(): void {
    this.state = { ...this.state, dubs: this.dubs, dubbing: this.dubbing, dubNotice: this.dubNotice }
    this.emit()
  }

  // --- audio ------------------------------------------------------------------

  /** Silences a track in the edit, or lets it be heard again. The recording keeps it either way. */
  setTrackMuted(track: AudioTrackKind, muted: boolean): void {
    const audio: AudioSettings = { ...this.project.audio, [track]: { ...this.project.audio[track], muted } }
    this.commit({ ...this.project, audio }, this.selected(), null)
  }

  // --- history ----------------------------------------------------------------

  /** Ends a drag or slider gesture, so the next edit starts a new undo step. */
  endGesture(): void {
    this.gestureKey = null
  }

  /** Runs several edits as one undo step (what the assistant does for one message). */
  runAsOneStep(edits: () => void): void {
    if (this.batch) {
      edits()
      return
    }
    this.gestureKey = null
    this.batch = { opened: false }
    try {
      edits()
    } finally {
      this.batch = null
      this.gestureKey = null
    }
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

  /** New captions replace the old ones entirely: translations of those no longer apply. */
  private withNewCues(cues: CaptionCue[], change: Partial<CaptionSettings>): CaptionSettings {
    return { ...this.project.captions, ...change, cues, language: null, translations: {} }
  }

  private refreshCaptionActivity(): void {
    this.state = { ...this.state, translating: this.translating, captionNotice: this.captionNotice }
    this.emit()
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

  private editText(textId: string, gestureKey: string | null, change: (text: TextOverlay) => TextOverlay): void {
    const texts = this.project.texts.map((text) => (text.id === textId ? change(text) : text))
    this.commitTexts(texts, textId, gestureKey)
  }

  private commitTexts(texts: readonly TextOverlay[], selectedTextId: string | null, gestureKey: string | null): void {
    const sorted = [...texts].sort((a, b) => a.startMs - b.startMs)
    this.commit({ ...this.project, texts: sorted }, { ...NOTHING_SELECTED, textId: selectedTextId }, gestureKey)
  }

  private commitCaptions(captions: CaptionSettings, gestureKey: string | null, selectedCueId: string | null): void {
    this.commit({ ...this.project, captions }, { ...NOTHING_SELECTED, cueId: selectedCueId }, gestureKey)
  }

  /** The selection an edit of the look (framing, webcam, export) leaves in place. */
  private selected(): Selected {
    return { zoomId: this.state.selectedZoomId, trimId: null, cueId: this.state.selectedCueId, textId: this.state.selectedTextId }
  }

  private commit(project: Project, selected: Selected, gestureKey: string | null): void {
    const continuesGesture = gestureKey !== null && gestureKey === this.gestureKey
    const continuesBatch = this.batch !== null && this.batch.opened
    if (!continuesGesture && !continuesBatch) {
      this.past.push(this.project)
      if (this.past.length > HISTORY_LIMIT) this.past.shift()
    }
    if (this.batch) this.batch.opened = true
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
    const textExists = project.texts.some((text) => text.id === this.state.selectedTextId)
    this.state = {
      ...this.derive(
        {
          zoomId: zoomExists ? this.state.selectedZoomId : null,
          trimId: trimExists ? this.state.selectedTrimId : null,
          cueId: cueExists ? this.state.selectedCueId : null,
          textId: textExists ? this.state.selectedTextId : null
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
      texts: this.project.texts,
      audio: this.project.audio,
      dub: this.project.dub,
      dubs: this.dubs,
      objectTrack: this.objectTrack,
      tracking: this.tracking,
      trackNotice: this.trackNotice,
      markingObject: this.markingObject,
      dubbing: this.dubbing,
      dubNotice: this.dubNotice,
      filters: this.project.filters,
      filterTrack: this.filterTrack,
      filtering: this.filtering,
      filterNotice: this.filterNotice,
      screenUrl: this.screenUrl(),
      trackingSource: this.screenUrl() === this.session.video.url ? 'screen' : 'screenFx',
      exportSettings: this.project.export,
      transcript: this.transcript,
      transcription: this.transcription,
      captionNotice: this.captionNotice,
      translating: this.translating,
      suggestions: this.pendingSuggestions(),
      suggesting: this.suggesting,
      suggestionNotice: this.suggestionNotice,
      selectedZoomId: selected.zoomId,
      selectedTrimId: selected.trimId,
      selectedCueId: selected.cueId,
      selectedTextId: selected.textId,
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
