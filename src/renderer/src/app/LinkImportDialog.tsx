import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/format'
import type { AppError } from '@shared/models/errors'
import type { LinkDownloadProgress, LinkToolStatus } from '@shared/models/link'
import { normalizeVideoLink } from '@shared/models/link'
import { LinkIcon, SparklesIcon } from './icons'

interface Props {
  onClose: () => void
  /** The video is in the library: on to a series made of it, or to the editor. */
  onDone: (sessionId: string, next: 'series' | 'edit') => void
}

const STAGE_LABELS: Record<LinkDownloadProgress['stage'], string> = {
  starting: 'Abrindo o link…',
  downloading: 'Baixando',
  importing: 'Trazendo para a biblioteca…',
  done: 'Pronto'
}

/**
 * A video from a link (YouTube and the many sites yt-dlp reads) into the
 * library. The tool is fetched from inside the app the first time, with its
 * size on the button; one installed with Homebrew is used as it is.
 */
export function LinkImportDialog({ onClose, onDone }: Props) {
  const [link, setLink] = useState('')
  const [tool, setTool] = useState<LinkToolStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<LinkDownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    void window.screenrx.link.status().then(setTool)
    return window.screenrx.link.onProgress(setProgress)
  }, [])

  const install = (): void => {
    setInstalling(true)
    setError(null)
    void window.screenrx.link
      .install()
      .then((result) => (result.ok ? setTool(result.value) : setError(result.error)))
      .finally(() => setInstalling(false))
  }

  const download = (): void => {
    setDownloading(true)
    setError(null)
    setProgress(null)
    void window.screenrx.link
      .download(link)
      .then((result) => {
        if (result.ok) setDone(result.value.sessionId)
        else if (result.error.code !== 'link-cancelled') setError(result.error)
      })
      .finally(() => setDownloading(false))
  }

  const valid = normalizeVideoLink(link) !== null
  const percent = progress?.fraction != null ? Math.round(progress.fraction * 100) : null

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog link-dialog" role="dialog" aria-modal="true" aria-label="Importar de um link">
        <h2 className="dialog-title">
          <LinkIcon /> Importar de um link
        </h2>

        {done === null ? (
          <>
            <input
              className="link-input"
              type="url"
              value={link}
              autoFocus
              spellCheck={false}
              placeholder="https://www.youtube.com/watch?v=…"
              aria-label="Link do vídeo"
              disabled={downloading}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && valid && tool?.installed && !downloading) download()
              }}
            />
            {tool && !tool.installed && (
              <div className="link-tool">
                <span>
                  Para baixar por link o app usa o <strong>yt-dlp</strong>
                  {tool.downloadBytes !== null && ` (${formatBytes(tool.downloadBytes)})`}, baixado uma vez para este Mac.
                </span>
                <button className="panel-button panel-button-small" disabled={installing} onClick={install}>
                  {installing ? 'Baixando…' : tool.downloadBytes !== null ? `Baixar (${formatBytes(tool.downloadBytes)})` : 'Baixar'}
                </button>
              </div>
            )}
            {downloading && (
              <div className="link-progress" role="status">
                <span>
                  {progress ? STAGE_LABELS[progress.stage] : STAGE_LABELS.starting}
                  {progress?.stage === 'downloading' && percent !== null && ` · ${percent}%`}
                  {progress?.title && <> · {progress.title}</>}
                </span>
                <progress max={1} value={progress?.fraction ?? undefined} />
              </div>
            )}
            <p className="muted link-note">Use só vídeos seus ou que você tem direito de republicar.</p>
          </>
        ) : (
          <p className="panel-hint series-made">
            <strong>{progress?.title ?? 'O vídeo'}</strong> está na biblioteca. Quer que a IA divida em episódios de uma série (nova ou existente)?
          </p>
        )}

        {error && (
          <p className="dialog-error" role="alert">
            {error.message}
          </p>
        )}

        <div className="dialog-actions">
          {done === null ? (
            <>
              <button className="panel-button" onClick={() => (downloading ? void window.screenrx.link.cancel() : onClose())}>
                Cancelar
              </button>
              <button className="panel-button panel-button-primary" disabled={!valid || !tool?.installed || downloading} onClick={download}>
                Baixar vídeo
              </button>
            </>
          ) : (
            <>
              <button className="panel-button" onClick={() => onDone(done, 'edit')}>
                Abrir no editor
              </button>
              <button className="panel-button panel-button-primary" onClick={() => onDone(done, 'series')}>
                <SparklesIcon /> Gerar série
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
