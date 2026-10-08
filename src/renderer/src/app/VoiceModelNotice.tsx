import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatBytes } from '@shared/format'
import { voiceModel } from '../common/voiceModel'

const DISMISSED_KEY = 'screenrx.voice-model-notice.dismissed'

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Offers the voice model dubbing needs, which is a large download made once and only when the user
 * asks. Shown on the library while the model is missing; "Agora não" hides it for good (the
 * settings and the Dublagem tab keep offering the download).
 */
export function VoiceModelNotice() {
  const voice = useSyncExternalStore(voiceModel.subscribe, voiceModel.getState)
  const [dismissed, setDismissed] = useState(readDismissed)

  useEffect(() => {
    void voiceModel.refresh()
  }, [])

  const { status, progress, failure } = voice
  if (status === null || !status.available) return null
  if (!progress && (status.model !== 'missing' || dismissed)) return null

  const dismiss = (): void => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Not remembering the choice is no reason to fail.
    }
    setDismissed(true)
  }

  if (progress) {
    return (
      <div className="notice" role="status">
        <div>
          <h2>{progress.stage === 'unpacking' ? 'Preparando o modelo de voz…' : 'Baixando o modelo de voz…'}</h2>
          <p>{Math.round(progress.fraction * 100)}%</p>
        </div>
        <div className="notice-actions">
          <button className="button" onClick={() => voiceModel.cancel()}>
            Cancelar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="notice" role="status">
      <div>
        <h2>Dublagem com a sua voz</h2>
        <p>
          {failure ?? `Baixe o modelo de voz uma única vez (${formatBytes(status.modelDownloadBytes)}). Tudo roda neste Mac.`}
        </p>
      </div>
      <div className="notice-actions">
        <button className="button" onClick={dismiss}>
          Agora não
        </button>
        <button className="button button-primary" onClick={() => void voiceModel.download()}>
          Baixar · {formatBytes(status.modelDownloadBytes)}
        </button>
      </div>
    </div>
  )
}
