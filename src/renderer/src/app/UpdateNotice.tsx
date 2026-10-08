import { useState } from 'react'
import { updateStatus, useUpdateStatus } from '../common/updateStatus'

interface Props {
  /** Restarting is only offered while nothing is being recorded. */
  idle: boolean
}

/**
 * Announces a version that has been downloaded and is waiting. It is installed when the app quits
 * anyway; this offers to do it now.
 */
export function UpdateNotice({ idle }: Props) {
  const update = useUpdateStatus()
  const [refused, setRefused] = useState(false)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  if (update?.status !== 'ready' || update.version === dismissedVersion) return null

  const restart = (): void => {
    void updateStatus.install().then((started) => setRefused(!started))
  }

  return (
    <div className="notice" role="status">
      <div>
        <h2>ScreenRx {update.version} está pronto para instalar</h2>
        <p>
          {refused
            ? 'Termine a gravação ou a exportação em andamento para reiniciar. A atualização também é instalada quando você fecha o app.'
            : 'A atualização é instalada quando você fecha o app. Reiniciar agora leva alguns segundos.'}
        </p>
      </div>
      <div className="notice-actions">
        <button className="button" onClick={() => setDismissedVersion(update.version ?? null)}>
          Depois
        </button>
        <button className="button button-primary" disabled={!idle} onClick={restart}>
          Reiniciar agora
        </button>
      </div>
    </div>
  )
}
