import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { createExportPlan } from '@engine/export/exportPlan'
import { formatBytes, formatClock } from '@shared/format'
import type { ExportResult } from '@shared/models/export'
import type { ExportFps } from '@shared/models/project'
import { EXPORT_FRAME_RATES } from '@shared/models/project'
import { ExportAbortedError, ExportFailedError, renderExport } from '../export/renderExport'
import type { EditorStore } from './EditorStore'

interface Props {
  store: EditorStore
  onClose: () => void
}

type Phase =
  | { kind: 'settings' }
  | { kind: 'rendering'; exportId: string | null; framesDone: number; frameCount: number }
  | { kind: 'done'; result: ExportResult }
  | { kind: 'failed'; message: string }

const FPS_HINTS: Record<ExportFps, string> = {
  24: 'Aparência de cinema. O arquivo é o menor e o mais rápido de exportar.',
  30: 'O padrão para vídeos na web.',
  60: 'Movimento mais fluido, como a tela foi gravada. O arquivo fica maior e a exportação leva mais tempo.'
}

const speedLabel = (speed: number): string => `${String(speed).replace('.', ',')}×`

/** Export settings, progress and result. */
export function ExportDialog({ store, onClose }: Props) {
  const { exportSettings, timeMap } = useSyncExternalStore(store.subscribe, store.getState)
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' })
  const abort = useRef<AbortController | null>(null)
  const { session } = store

  // Closing the editor mid-export must not leave an encoder running.
  useEffect(() => () => abort.current?.abort(), [])

  const plan = createExportPlan(
    { width: session.video.widthPx, height: session.video.heightPx },
    timeMap,
    exportSettings
  )

  const run = async (): Promise<void> => {
    const controller = new AbortController()
    abort.current = controller
    setPhase({ kind: 'rendering', exportId: null, framesDone: 0, frameCount: plan.frameCount })
    // The encoder reads the project from disk, so it must be up to date.
    await store.flush()

    const started = await window.screenrx.export.start(session.sessionId)
    if (!started.ok) {
      setPhase(
        started.error.code === 'export-cancelled'
          ? { kind: 'settings' }
          : { kind: 'failed', message: started.error.message }
      )
      return
    }
    const job = started.value
    const project = store.snapshot()
    try {
      await renderExport(
        job,
        session,
        project,
        (framesDone) =>
          setPhase({ kind: 'rendering', exportId: job.exportId, framesDone, frameCount: job.plan.frameCount }),
        controller.signal
      )
      const finished = await window.screenrx.export.finish(job.exportId)
      setPhase(finished.ok ? { kind: 'done', result: finished.value } : { kind: 'failed', message: finished.error.message })
    } catch (error) {
      await window.screenrx.export.cancel(job.exportId)
      if (error instanceof ExportAbortedError) setPhase({ kind: 'settings' })
      else if (error instanceof ExportFailedError) setPhase({ kind: 'failed', message: error.appError.message })
      else setPhase({ kind: 'failed', message: 'A exportação falhou.' })
    }
  }

  const rendering = phase.kind === 'rendering'
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Exportar vídeo">
        <h2 className="dialog-title">Exportar vídeo</h2>

        {phase.kind === 'settings' && (
          <>
            <div className="dialog-field">
              <span className="dialog-label">Velocidade</span>
              <div className="chips" role="radiogroup" aria-label="Velocidade de exportação">
                {EXPORT_CONFIG.speeds.map((speed) => (
                  <button
                    key={speed}
                    className="chip"
                    role="radio"
                    aria-checked={speed === exportSettings.speed}
                    onClick={() => store.setExportSettings({ speed })}
                  >
                    {speedLabel(speed)}
                  </button>
                ))}
              </div>
              <p className="panel-hint">
                Acelera ou desacelera o vídeo inteiro. A voz mantém o tom natural.
              </p>
            </div>

            <div className="dialog-field">
              <span className="dialog-label">Quadros por segundo</span>
              <div className="chips" role="radiogroup" aria-label="Quadros por segundo">
                {EXPORT_FRAME_RATES.map((fps) => (
                  <button
                    key={fps}
                    className="chip"
                    role="radio"
                    aria-checked={fps === exportSettings.fps}
                    onClick={() => store.setExportSettings({ fps })}
                  >
                    {fps} fps
                  </button>
                ))}
              </div>
              <p className="panel-hint">{FPS_HINTS[exportSettings.fps]}</p>
            </div>

            <div className="dialog-field">
              <span className="dialog-label">Qualidade</span>
              <div className="chips" role="radiogroup" aria-label="Qualidade">
                {(['standard', 'high'] as const).map((quality) => (
                  <button
                    key={quality}
                    className="chip"
                    role="radio"
                    aria-checked={quality === exportSettings.quality}
                    onClick={() => store.setExportSettings({ quality })}
                  >
                    {quality === 'high' ? 'Alta' : 'Padrão'}
                  </button>
                ))}
              </div>
            </div>

            <dl className="dialog-summary">
              <div>
                <dt>Duração</dt>
                <dd>{formatClock(plan.outputDurationMs)}</dd>
              </div>
              <div>
                <dt>Resolução</dt>
                <dd>
                  {plan.width}×{plan.height}
                </dd>
              </div>
              <div>
                <dt>Formato</dt>
                <dd>MP4 · H.264 · {plan.fps} fps</dd>
              </div>
            </dl>

            <div className="dialog-actions">
              <button className="panel-button" onClick={onClose}>
                Cancelar
              </button>
              <button className="panel-button panel-button-primary" onClick={() => void run()}>
                Exportar MP4
              </button>
            </div>
          </>
        )}

        {rendering && (
          <>
            <p className="panel-hint">
              {phase.exportId === null
                ? 'Preparando…'
                : `Renderizando quadro ${phase.framesDone} de ${phase.frameCount}`}
            </p>
            <progress className="dialog-progress" max={phase.frameCount} value={phase.framesDone} />
            <div className="dialog-actions">
              <button className="panel-button" onClick={() => abort.current?.abort()}>
                Cancelar exportação
              </button>
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <p className="dialog-result">
              <strong>{phase.result.fileName}</strong>
              <span className="panel-hint">{formatBytes(phase.result.sizeBytes)}</span>
            </p>
            <div className="dialog-actions">
              <button
                className="panel-button"
                onClick={() => void window.screenrx.export.reveal(phase.result.exportId)}
              >
                Mostrar no Finder
              </button>
              <button className="panel-button panel-button-primary" onClick={onClose}>
                Concluir
              </button>
            </div>
          </>
        )}

        {phase.kind === 'failed' && (
          <>
            <p className="dialog-error" role="alert">
              {phase.message}
            </p>
            <div className="dialog-actions">
              <button className="panel-button" onClick={onClose}>
                Fechar
              </button>
              <button className="panel-button panel-button-primary" onClick={() => setPhase({ kind: 'settings' })}>
                Tentar de novo
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
