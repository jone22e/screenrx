import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { EditorSession } from '@shared/models/editor'
import type { AppError } from '@shared/models/errors'
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
      if (exporting) return
      const typing = event.target instanceof HTMLInputElement && event.target.type !== 'range'
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
        !store.selectedTrim
      ) {
        event.preventDefault()
        store.cutSelection()
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && store.selectedZoom) {
        event.preventDefault()
        store.removeZoom(store.selectedZoom.id)
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && store.selectedTrim) {
        event.preventDefault()
        store.removeTrim(store.selectedTrim.id)
      } else if (event.key === 'Escape') {
        store.select(null)
        store.setSelection(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [player, store, exporting])

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

      <div className="editor-main">
        <div className="editor-stage">
          <Preview session={session} store={store} onPlayerReady={setPlayer} />
          {player && <Transport player={player} store={store} />}
        </div>
        <Sidebar session={session} store={store} player={player} />
      </div>

      {player && <Timeline session={session} store={store} player={player} />}
      {exporting && <ExportDialog store={store} onClose={() => setExporting(false)} />}
    </div>
  )
}
