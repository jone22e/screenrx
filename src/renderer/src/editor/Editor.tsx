import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { EditorSession } from '@shared/models/editor'
import type { AppError } from '@shared/models/errors'
import { useSettingsOpen } from '../common/settingsScreen'
import { EditorStore } from './EditorStore'
import { ExportDialog } from './ExportDialog'
import type { SaveStatus } from './EditorStore'
import { Preview } from './Preview'
import type { PreviewPlayer } from './PreviewPlayer'
import { Sidebar } from './Sidebar'
import { Timeline } from './Timeline'
import { Transport } from './Transport'
import { BackIcon, ExportIcon, RedoIcon, UndoIcon } from './icons'
import './editor.css'

interface Props {
  sessionId: string
  onClose: () => void
}

const SAVE_LABELS: Record<SaveStatus, string> = {
  saved: 'Todas as alterações salvas',
  pending: 'Salvando…',
  failed: 'Não foi possível salvar'
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })

/** Loads a recording and hands it to the workspace. */
export function Editor({ sessionId, onClose }: Props) {
  const [loaded, setLoaded] = useState<{ session: EditorSession } | { error: AppError } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.screenrx.editor.open(sessionId).then((result) => {
      if (cancelled) return
      setLoaded(result.ok ? { session: result.value } : { error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (loaded && 'session' in loaded && loaded.session.sessionId === sessionId) {
    return <Workspace key={sessionId} session={loaded.session} onClose={onClose} />
  }
  return (
    <div className="editor">
      <header className="editor-toolbar">
        <button className="tool-button" onClick={onClose}>
          <BackIcon /> Gravações
        </button>
      </header>
      <p className="editor-message">
        {loaded && 'error' in loaded ? loaded.error.message : 'Abrindo gravação…'}
      </p>
    </div>
  )
}

function Workspace({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const store = useMemo(
    () => new EditorStore(session, (project) => window.screenrx.editor.saveProject(project)),
    [session]
  )
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [player, setPlayer] = useState<PreviewPlayer | null>(null)
  const [exporting, setExporting] = useState(false)
  // With the settings screen over the editor, the keyboard is not the editor's.
  const settingsOpen = useSettingsOpen()

  // Nothing is lost when leaving: pending edits are written immediately.
  useEffect(() => {
    const flush = (): void => void store.flush()
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [store])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (exporting || settingsOpen) return
      const typing =
        (event.target instanceof HTMLInputElement && event.target.type !== 'range') ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      if (typing) return
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
      } else if (event.code === 'Space') {
        event.preventDefault()
        player?.toggle()
      } else if (event.key.toLowerCase() === 'i' && player) {
        store.markSelection('start', player.currentTimeMs)
      } else if (event.key.toLowerCase() === 'o' && player) {
        store.markSelection('end', player.currentTimeMs)
      } else if (
        (event.key.toLowerCase() === 'x' || event.key === 'Backspace' || event.key === 'Delete') &&
        store.getState().selection &&
        !store.selectedZoom &&
        !store.selectedTrim &&
        !store.selectedCue &&
        !store.selectedText
      ) {
        event.preventDefault()
        store.cutSelection()
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && store.selectedZoom) {
        event.preventDefault()
        store.removeZoom(store.selectedZoom.id)
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && store.selectedTrim) {
        event.preventDefault()
        store.removeTrim(store.selectedTrim.id)
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && store.selectedCue) {
        event.preventDefault()
        store.removeCue(store.selectedCue.id)
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && store.selectedText) {
        event.preventDefault()
        store.removeText(store.selectedText.id)
      } else if (event.key === 'Escape') {
        store.select(null)
        store.setSelection(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [player, store, exporting, settingsOpen])

  useEffect(() => {
    if (settingsOpen) player?.pause()
  }, [settingsOpen, player])

  // Transcription runs in the main process; its progress is shown wherever the user is.
  useEffect(() => {
    const unsubscribe = window.screenrx.captions.onProgress((progress) => {
      if (progress.sessionId === session.sessionId && store.transcribing) {
        store.setTranscription({ stage: progress.stage, fraction: progress.fraction })
      }
    })
    return () => {
      unsubscribe()
      // Leaving the editor abandons a transcription that is still running.
      if (store.transcribing) void window.screenrx.captions.cancel()
      if (store.getState().suggesting) void window.screenrx.ai.cancel()
    }
  }, [session, store])

  // Object tracking too: the native tracker reports how far it got.
  useEffect(() => {
    const unsubscribe = window.screenrx.track.onProgress((progress) => {
      if (progress.sessionId === session.sessionId) store.setTrackProgress(progress.fraction)
    })
    return () => {
      unsubscribe()
      if (store.trackingObject) void window.screenrx.track.cancel()
    }
  }, [session, store])

  // The rendered effects (stabilization and the like) are a derived track made by FFmpeg in the
  // main process: whenever their settings change, the track is made again after a short pause.
  useEffect(() => {
    const render = (sessionId: string, request: Parameters<typeof window.screenrx.filters.render>[1]) =>
      window.screenrx.filters.render(sessionId, request)
    const cancel = (): void => void window.screenrx.filters.cancel()
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void store.renderFilters(render, cancel), 400)
    }
    schedule()
    const unsubscribe = store.subscribe(schedule)
    const stopProgress = window.screenrx.filters.onProgress((progress) => {
      if (progress.sessionId === session.sessionId) store.setFilterProgress(progress.fraction)
    })
    return () => {
      unsubscribe()
      stopProgress()
      if (timer) clearTimeout(timer)
      if (store.getState().filtering) cancel()
    }
  }, [session, store])

  // So does dubbing: it runs in the main process and its helper.
  useEffect(() => {
    const unsubscribe = window.screenrx.dub.onProgress((progress) => store.setDubProgress(progress))
    return () => {
      unsubscribe()
      if (store.getState().dubbing) void window.screenrx.dub.cancel()
    }
  }, [store])

  const openExport = (): void => {
    player?.pause()
    setExporting(true)
  }

  return (
    <div className="editor">
      <header className="editor-toolbar">
        <button className="tool-button" onClick={onClose}>
          <BackIcon /> Gravações
        </button>
        <div className="editor-heading">
          <span className="editor-title">{session.title}</span>
          <span className="editor-subtitle">{dateFormat.format(new Date(session.createdAt))}</span>
        </div>
        <span className="editor-save" data-status={state.saveStatus}>
          {SAVE_LABELS[state.saveStatus]}
        </span>
        <div className="tool-group">
          <button
            className="tool-button tool-icon"
            aria-label="Desfazer"
            title="Desfazer (⌘Z)"
            disabled={!state.canUndo}
            onClick={() => store.undo()}
          >
            <UndoIcon />
          </button>
          <button
            className="tool-button tool-icon"
            aria-label="Refazer"
            title="Refazer (⇧⌘Z)"
            disabled={!state.canRedo}
            onClick={() => store.redo()}
          >
            <RedoIcon />
          </button>
        </div>
        <button className="tool-button tool-primary" disabled={!player} onClick={openExport}>
          <ExportIcon /> Exportar
        </button>
      </header>

      <Sidebar session={session} store={store} player={player} />
      <div className="editor-stage">
        <Preview session={session} store={store} onPlayerReady={setPlayer} />
        {player && <Transport player={player} store={store} />}
      </div>

      {player && <Timeline session={session} store={store} player={player} />}
      {exporting && <ExportDialog store={store} onClose={() => setExporting(false)} />}
    </div>
  )
}
