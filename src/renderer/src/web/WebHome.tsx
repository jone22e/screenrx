import { useEffect, useState } from 'react'
import type { DragEvent } from 'react'
import { formatBytes, formatClock } from '@shared/format'
import { VIDEO_KINDS, canKeepFileHandles, fileFromHandle, isOfKind, pickFiles } from './files'
import { OpenVideoError, webSessions } from './sessions'
import type { RecentVideo } from './storage'
import { webStorage } from './storage'
import { WebRecordPanel } from './WebRecordPanel'
import type { WebRecording } from './webRecorder'
import { FilmIcon } from '../editor/icons'

interface Props {
  onOpen: (sessionId: string) => void
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * The web editor's front door: a video file to open, by dialog or dropped on
 * the page, and the ones opened lately. Each keeps its edit in the browser,
 * so the same file opened again comes back as it was left.
 */
export function WebHome({ onOpen }: Props) {
  const [recent, setRecent] = useState<RecentVideo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    void webStorage.listRecent().then(setRecent, () => setRecent([]))
  }, [])

  const open = async (file: File, handle: FileSystemFileHandle | null): Promise<void> => {
    setBusy(file.name)
    setNotice(null)
    try {
      const video = await webSessions.open(file, handle)
      onOpen(video.sessionId)
    } catch (error) {
      setNotice(error instanceof OpenVideoError ? error.appError.message : 'Não foi possível abrir este vídeo.')
      setBusy(null)
    }
  }

  const recorded = async (recording: WebRecording): Promise<void> => {
    await open(recording.file, recording.handle)
  }

  const choose = async (): Promise<void> => {
    const { files, handles } = await pickFiles(VIDEO_KINDS, false, 'Vídeo MP4 ou MOV')
    const file = files[0]
    if (file) await open(file, handles[0] ?? null)
  }

  const reopen = async (video: RecentVideo): Promise<void> => {
    if (!video.handle) {
      setNotice(`Escolha o arquivo "${video.title}" de novo: a edição dele volta sozinha.`)
      return
    }
    const file = await fileFromHandle(video.handle)
    if (!file) {
      setNotice('O navegador não deixou abrir o arquivo de novo. Escolha-o pelo botão.')
      return
    }
    await open(file, video.handle)
  }

  const forget = async (video: RecentVideo): Promise<void> => {
    await webStorage.removeRecent(video.sessionId).catch(() => undefined)
    setRecent((current) => current.filter((known) => known.sessionId !== video.sessionId))
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDropping(false)
    const file = [...event.dataTransfer.files].find((candidate) => isOfKind(candidate, VIDEO_KINDS))
    if (file) void open(file, null)
    else setNotice('Solte um vídeo MP4 ou MOV.')
  }

  return (
    <div
      className="web-home"
      data-dropping={dropping}
      onDragOver={(event) => {
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header className="web-home-head">
        <span className="web-home-brand">ScreenRx</span>
        <span className="web-home-tag">Editor web</span>
      </header>

      <section className="web-home-open" aria-label="Abrir vídeo">
        <FilmIcon />
        <h1>Edite um vídeo aqui mesmo, no navegador</h1>
        <p className="muted">MP4 ou MOV. O vídeo não sai do seu computador: a edição e a exportação acontecem nesta página.</p>
        <button className="panel-button panel-button-primary web-home-button" disabled={busy !== null} onClick={() => void choose()}>
          {busy ? `Abrindo ${busy}…` : 'Abrir vídeo…'}
        </button>
        <p className="muted">ou solte o arquivo nesta janela</p>
        {notice && (
          <p className="panel-notice" role="alert">
            {notice}
          </p>
        )}
      </section>

      <WebRecordPanel onRecorded={recorded} disabled={busy !== null} />

      {recent.length > 0 && (
        <section className="web-home-recent" aria-label="Abertos recentemente">
          <h2>Abertos recentemente</h2>
          <ul>
            {recent.map((video) => (
              <li key={video.sessionId}>
                <button className="web-recent" disabled={busy !== null} title={video.handle ? 'Abrir de novo' : 'Escolha o arquivo de novo para continuar a edição'} onClick={() => void reopen(video)}>
                  <strong>{video.title}</strong>
                  <span className="muted">
                    {formatClock(video.durationMs)} · {formatBytes(video.sizeBytes)} · {dateFormat.format(new Date(video.openedAt))}
                  </span>
                </button>
                <button className="web-recent-forget" aria-label="Tirar da lista" title="Tirar da lista" onClick={() => void forget(video)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {!canKeepFileHandles() && <p className="muted">Neste navegador o arquivo precisa ser escolhido de novo; a edição fica guardada.</p>}
        </section>
      )}
    </div>
  )
}
