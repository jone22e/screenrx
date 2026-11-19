import { useState } from 'react'
import { Editor } from '../editor/Editor'
import { WebHome } from './WebHome'
import './web.css'

/** The web editor: a video to open, then the same editor the desktop app has, with what the browser can do. */
export function WebApp() {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="app" data-platform="web">
      {editing ? <Editor sessionId={editing} onClose={() => setEditing(null)} /> : <WebHome onOpen={setEditing} />}
    </div>
  )
}
