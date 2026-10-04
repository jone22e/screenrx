import { useState } from 'react'
import { useRecordingState } from '../common/recordingStore'
import { Editor } from '../editor/Editor'
import { Home } from './Home'
import { useLibrary } from './hooks'

export function App() {
  const state = useRecordingState()
  const recordings = useLibrary()

  // A recording that has just finished opens straight in the editor.
  const [view, setView] = useState<{ editing: string | null; lastSeen: string | null }>({
    editing: null,
    lastSeen: state.lastCompletedSessionId
  })
  if (state.lastCompletedSessionId !== view.lastSeen) {
    setView({ editing: state.lastCompletedSessionId, lastSeen: state.lastCompletedSessionId })
  }
  const edit = (sessionId: string | null): void => setView({ ...view, editing: sessionId })

  return (
    <div className="app">
      {view.editing ? (
        // The editor brings its own toolbar, which doubles as the window's title bar.
        <Editor sessionId={view.editing} onClose={() => edit(null)} />
      ) : (
        <Home state={state} recordings={recordings} onEdit={edit} />
      )}
    </div>
  )
}
