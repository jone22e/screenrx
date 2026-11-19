import { useSyncExternalStore } from 'react'
import type { PublishState } from '@shared/models/instagram'
import type { RecordingSummary } from '@shared/models/session'
import { openSettings } from '../common/settingsScreen'
import { InstagramIcon } from './icons'
import { publishQueue } from './publishQueue'

interface Props {
  recordings: readonly RecordingSummary[]
  connected: boolean
}

const STAGE_LABELS: Partial<Record<PublishState, string>> = {
  rendering: 'Preparando o Reel',
  uploading: 'Enviando',
  processing: 'O Instagram está processando'
}

/** One line over the library while the queue publishes: which video, how far, how many wait. */
export function PublishStatus({ recordings, connected }: Props) {
  const queue = useSyncExternalStore(publishQueue.subscribe, publishQueue.getState)
  const waiting = recordings.filter((recording) => recording.publish?.state === 'approved').length
  const { current } = queue

  if (!current && waiting === 0) return null
  if (!connected && !current) {
    return (
      <div className="notice publish-status" role="status">
        <p>
          <InstagramIcon /> {waiting === 1 ? '1 vídeo aprovado espera' : `${waiting} vídeos aprovados esperam`} uma conta do Instagram conectada.
        </p>
        <button className="button" onClick={openSettings}>
          Conectar
        </button>
      </div>
    )
  }
  const percent = current?.fraction != null ? Math.round(current.fraction * 100) : null
  return (
    <div className="notice publish-status" role="status">
      <p>
        <InstagramIcon />{' '}
        {current ? (
          <>
            <strong>{current.title}</strong> · {STAGE_LABELS[current.state] ?? 'Publicando'}
            {percent !== null && current.state !== 'processing' && ` ${percent}%`}
          </>
        ) : (
          'Publicação no Instagram'
        )}
        {current && waiting > 0 && <span className="muted"> · mais {waiting} na fila</span>}
        <span className="muted"> · deixe o app aberto até terminar</span>
      </p>
      {current?.state === 'rendering' && (
        <button className="button" title="Parar e tirar este vídeo da fila" onClick={() => publishQueue.stopRendering()}>
          Parar
        </button>
      )}
      {current && current.fraction !== null && current.state !== 'processing' && <progress className="publish-progress" max={1} value={current.fraction} />}
    </div>
  )
}
