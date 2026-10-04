import { isExportSpeed } from '@engine/export/exportConfig'
import type { TimeMap } from '@engine/time/timeMapping'
import { buildTimeMap } from '@engine/time/timeMapping'
import { moveSpan, resizeSpan, spanForNew } from '@engine/timeline/spanEditing'
import { TRIM_CONFIG } from '@engine/timeline/trimConfig'
import { regenerateAutoZooms } from '@engine/zoom/autoZoom'
import { MANUAL_ZOOM_DEFAULTS } from '@engine/zoom/zoomConfig'
import type { TimeSpan } from '@engine/zoom/zoomEditing'
import { clampScale, spanForNewZoom } from '@engine/zoom/zoomEditing'
import type { EditorSession } from '@shared/models/editor'
import type { IpcResult } from '@shared/models/errors'
import type {
  BackgroundSettings,
  ExportSettings,
  NormalizedPoint,
  Project,
  TrimEffect,
  WebcamSettings,
  ZoomEffect
} from '@shared/models/project'
import { BACKGROUND_LIMITS, WEBCAM_LIMITS, trimsOf, zoomsOf } from '@shared/models/project'

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
  exportSettings: ExportSettings
  /** UI state: never persisted. At most one region is selected at a time. */
  selectedZoomId: string | null
  selectedTrimId: string | null
  /** UI state: a stretch of the recording marked on the timeline, e.g. to cut it. */
  selection: TimeSpan | null
  saveStatus: SaveStatus
  canUndo: boolean
  canRedo: boolean
}

type SaveProject = (project: Project) => Promise<IpcResult<null>>

const createZoomId = (): string => `zoom-${crypto.randomUUID()}`
const createTrimId = (): string => `trim-${crypto.randomUUID()}`

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/**
 * The project being edited. Every edit only changes the description of an
 * effect — the recorded media is never touched — and is saved automatically
 * a moment later. Edits can be undone and redone.
 */
export class EditorStore {
  private project: Project
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
    this.state = this.derive(null, null, 'saved')
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

  select(zoomId: string | null): void {
    if (zoomId === this.state.selectedZoomId && this.state.selectedTrimId === null) return
    this.state = { ...this.state, selectedZoomId: zoomId, selectedTrimId: null }
    this.emit()
  }

  selectTrim(trimId: string | null): void {
    if (trimId === this.state.selectedTrimId && this.state.selectedZoomId === null) return
    this.state = { ...this.state, selectedZoomId: null, selectedTrimId: trimId }
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
    const touching = this.state.trims.filter(
      (trim) => trim.startMs <= selection.endMs && trim.endMs >= selection.startMs
    )
    const cut: TrimEffect = {
      id: createTrimId(),
      type: 'trim',
      startMs: Math.min(selection.startMs, ...touching.map((trim) => trim.startMs)),
      endMs: Math.max(selection.endMs, ...touching.map((trim) => trim.endMs))
    }
    const others = this.state.trims.filter((trim) => !touching.includes(trim))
    return this.commitTrims([...others, cut], cut.id, null)
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
    if (!isExportSpeed(next.speed)) return
    this.commit({ ...this.project, export: next }, this.state.selectedZoomId, null)
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
    this.commit({ ...this.project, background }, this.state.selectedZoomId, gestureKey)
  }

  setWebcam(change: Partial<WebcamSettings>, gestureKey: string | null = null): void {
    const merged = { ...this.project.webcam, ...change }
    const webcam: WebcamSettings = {
      ...merged,
      sizeRatio: clamp(merged.sizeRatio, WEBCAM_LIMITS.minSizeRatio, WEBCAM_LIMITS.maxSizeRatio),
      position: { x: clamp(merged.position.x, 0, 1), y: clamp(merged.position.y, 0, 1) }
    }
    this.commit({ ...this.project, webcam }, this.state.selectedZoomId, gestureKey)
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
    this.commit({ ...this.project, effects }, null, gestureKey, selectedTrimId)
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
    this.commit({ ...this.project, effects: [...others, ...sorted] }, selectedZoomId, gestureKey)
  }

  private commit(
    project: Project,
    selectedZoomId: string | null,
    gestureKey: string | null,
    selectedTrimId: string | null = null
  ): void {
    const continuesGesture = gestureKey !== null && gestureKey === this.gestureKey
    if (!continuesGesture) {
      this.past.push(this.project)
      if (this.past.length > HISTORY_LIMIT) this.past.shift()
    }
    this.future = []
    this.gestureKey = gestureKey
    this.project = project
    // A cut consumes the selection it was made from; other edits leave it alone.
    const selection = selectedTrimId !== null && gestureKey === null ? null : this.state.selection
    this.state = { ...this.derive(selectedZoomId, selectedTrimId, 'pending'), selection }
    this.emit()
    this.scheduleSave()
  }

  private restore(project: Project): void {
    this.gestureKey = null
    this.project = project
    const zoomExists = zoomsOf(project).some((zoom) => zoom.id === this.state.selectedZoomId)
    const trimExists = trimsOf(project).some((trim) => trim.id === this.state.selectedTrimId)
    this.state = {
      ...this.derive(
        zoomExists ? this.state.selectedZoomId : null,
        trimExists ? this.state.selectedTrimId : null,
        'pending'
      ),
      selection: this.state.selection
    }
    this.emit()
    this.scheduleSave()
  }

  private derive(
    selectedZoomId: string | null,
    selectedTrimId: string | null,
    saveStatus: SaveStatus
  ): EditorState {
    return {
      zooms: zoomsOf(this.project),
      trims: trimsOf(this.project),
      timeMap: buildTimeMap(this.session.durationMs, this.project.effects),
      background: this.project.background,
      webcam: this.project.webcam,
      exportSettings: this.project.export,
      selectedZoomId,
      selectedTrimId,
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
