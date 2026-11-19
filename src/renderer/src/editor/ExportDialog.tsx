import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { createExportPlan, estimatedFileBytes } from '@engine/export/exportPlan'
import type { PlatformPreset } from '@engine/export/platformPresets'
import { PLATFORM_PRESETS, applyPlatformPreset, platformPreset, presetWarnings } from '@engine/export/platformPresets'
import { formatBytes, formatClock } from '@shared/format'
import type { ExportOverrides, ExportResult } from '@shared/models/export'
import type { ExportCompression, ExportFps, ExportPreset } from '@shared/models/project'
import { EXPORT_COMPRESSION_LEVELS, EXPORT_FRAME_RATES } from '@shared/models/project'
import { FRAME_ASPECT_LABELS } from './frameAspects'
import { ExportAbortedError, ExportFailedError, renderExport } from '../export/renderExport'
import { features } from '../common/platform'
import type { EditorStore } from './EditorStore'

interface Props {
  store: EditorStore
  onClose: () => void
}

/** One file of a batch: which platform, and what it is made with. */
interface BatchItem {
  label: string
  overrides: ExportOverrides | null
}

type Phase =
  | { kind: 'settings' }
  | { kind: 'rendering'; exportId: string | null; framesDone: number; frameCount: number; item: number; total: number; label: string }
  | { kind: 'done'; results: ExportResult[] }
  | { kind: 'failed'; message: string; results: ExportResult[] }

const FPS_HINTS: Record<ExportFps, string> = {
  24: 'Aparência de cinema. O arquivo é o menor e o mais rápido de exportar.',
  30: 'O padrão para vídeos na web.',
  60: 'Movimento mais fluido, como a tela foi gravada. O arquivo fica maior e a exportação leva mais tempo.'
}

const speedLabel = (speed: number): string => `${String(speed).replace('.', ',')}×`

/** Each compression level, in the user's words. */
const COMPRESSION_LABELS: Record<ExportCompression, { label: string; hint: string }> = {
  0: { label: 'Nenhuma', hint: 'H.264 na taxa cheia. O maior arquivo; abre em qualquer lugar.' },
  1: { label: 'Leve', hint: 'H.264 com menos bits: cerca de 25% menor, sem diferença visível. Abre em qualquer lugar.' },
  2: { label: 'Média', hint: 'HEVC (H.265): cerca de 45% menor com a mesma nitidez. Abre no Mac, no iPhone, no Windows 10+ e nas redes sociais.' },
  3: { label: 'Alta', hint: 'HEVC com menos bits: cerca de 60% menor. Gravações de tela, quase paradas, continuam nítidas.' },
  4: { label: 'Máxima', hint: 'HEVC no mínimo que mantém a imagem nítida: cerca de 70% menor. Movimento rápido pode perder detalhe.' }
}

/** Export settings, progress and result. */
export function ExportDialog({ store, onClose }: Props) {
  const { exportSettings, timeMap, background } = useSyncExternalStore(store.subscribe, store.getState)
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' })
  // Other platforms to make a file for in the same go, each with its own settings and shape.
  const [batch, setBatch] = useState<ReadonlySet<Exclude<ExportPreset, 'custom'>>>(() => new Set())
  const abort = useRef<AbortController | null>(null)
  const { session } = store

  // Closing the editor mid-export must not leave an encoder running.
  useEffect(() => () => abort.current?.abort(), [])

  const sourceSize = { width: session.video.widthPx, height: session.video.heightPx }
  const plan = createExportPlan(sourceSize, timeMap, exportSettings, background.aspect)
  const withAudio = session.audio.length > 0 || store.getState().musicTrack !== null
  const platform = platformPreset(exportSettings.preset)
  const warnings = platform ? presetWarnings(platform, plan, estimatedFileBytes(plan, withAudio), background.aspect) : []

  /** The settings and shape a platform's file in the batch is made with. */
  const overridesFor = (preset: PlatformPreset): ExportOverrides => ({
    export: applyPlatformPreset(exportSettings, preset),
    aspect: preset.aspect ?? background.aspect
  })

  const toggleBatch = (preset: Exclude<ExportPreset, 'custom'>): void => {
    setBatch((current) => {
      const next = new Set(current)
      if (next.has(preset)) next.delete(preset)
      else next.add(preset)
      return next
    })
  }

  /** Exports one file; returns the result, or `null` when the user gave up on it. Throws on failure. */
  const exportOne = async (item: BatchItem, index: number, total: number, signal: AbortSignal): Promise<ExportResult | null> => {
    setPhase({ kind: 'rendering', exportId: null, framesDone: 0, frameCount: plan.frameCount, item: index, total, label: item.label })
    const started = await window.screenrx.export.start(session.sessionId, item.overrides)
    if (!started.ok) {
      if (started.error.code === 'export-cancelled') return null
      throw new ExportFailedError(started.error)
    }
    const job = started.value
    const base = store.snapshot()
    const project = item.overrides
      ? { ...base, export: item.overrides.export, background: { ...base.background, aspect: item.overrides.aspect } }
      : base
    try {
      await renderExport(
        job,
        // The images and clips brought in since the editor opened are drawn too.
        { ...session, images: [...store.getState().images], clips: [...store.getState().clips] },
        project,
        store.getState().objectTrack,
        (framesDone) =>
          setPhase({ kind: 'rendering', exportId: job.exportId, framesDone, frameCount: job.plan.frameCount, item: index, total, label: item.label }),
        signal
      )
      const finished = await window.screenrx.export.finish(job.exportId)
      if (!finished.ok) throw new ExportFailedError(finished.error)
      return finished.value
    } catch (error) {
      await window.screenrx.export.cancel(job.exportId)
      throw error
    }
  }

  const run = async (): Promise<void> => {
    const controller = new AbortController()
    abort.current = controller
    // The encoder reads the project from disk, so it must be up to date.
    await store.flush()
    const items: BatchItem[] = [
      { label: platform ? platform.label : 'Vídeo', overrides: null },
      ...PLATFORM_PRESETS.filter((preset) => batch.has(preset.id) && preset.id !== exportSettings.preset).map((preset) => ({
        label: preset.label,
        overrides: overridesFor(preset)
      }))
    ]
    const results: ExportResult[] = []
    try {
      for (const [index, item] of items.entries()) {
        const result = await exportOne(item, index + 1, items.length, controller.signal)
        if (result === null) break
        results.push(result)
      }
      setPhase(results.length === 0 ? { kind: 'settings' } : { kind: 'done', results })
    } catch (error) {
      if (error instanceof ExportAbortedError) setPhase(results.length === 0 ? { kind: 'settings' } : { kind: 'done', results })
      else if (error instanceof ExportFailedError) setPhase({ kind: 'failed', message: error.appError.message, results })
      else setPhase({ kind: 'failed', message: 'A exportação falhou.', results })
    }
  }

  const rendering = phase.kind === 'rendering'
  const batchCount = PLATFORM_PRESETS.filter((preset) => batch.has(preset.id) && preset.id !== exportSettings.preset).length
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Exportar vídeo">
        <h2 className="dialog-title">Exportar vídeo</h2>

        {phase.kind === 'settings' && (
          <>
            <div className="dialog-field">
              <span className="dialog-label">Para onde vai</span>
              <div className="presets" role="radiogroup" aria-label="Plataforma">
                <button
                  className="preset"
                  role="radio"
                  aria-checked={exportSettings.preset === 'custom'}
                  onClick={() => store.applyExportPreset('custom')}
                >
                  Manual
                </button>
                {PLATFORM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className="preset"
                    role="radio"
                    aria-checked={exportSettings.preset === preset.id}
                    title={preset.hint}
                    onClick={() => store.applyExportPreset(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="panel-hint">
                {platform
                  ? platform.hint
                  : 'A plataforma acerta resolução, codec, fps e formato de uma vez.'}
              </p>
              {warnings.map((warning) => (
                <p key={warning.kind} className="dialog-warning" role="alert">
                  {warning.message}
                </p>
              ))}
            </div>

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
                    onClick={() => store.setExportSettings({ fps, preset: 'custom' })}
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
                    onClick={() => store.setExportSettings({ quality, preset: 'custom' })}
                  >
                    {quality === 'high' ? 'Alta' : 'Padrão'}
                  </button>
                ))}
              </div>
            </div>

            <div className="dialog-field">
              <span className="dialog-label">
                Compactação <strong className="dialog-value">{COMPRESSION_LABELS[exportSettings.compression].label}</strong>
              </span>
              <input
                type="range"
                className="dialog-slider"
                aria-label="Compactação"
                min={0}
                max={EXPORT_COMPRESSION_LEVELS.length - 1}
                step={1}
                value={exportSettings.compression}
                onChange={(event) =>
                  store.setExportSettings({ compression: Number(event.target.value) as ExportCompression, preset: 'custom' })
                }
              />
              <div className="dialog-slider-ends" aria-hidden="true">
                <span>Nenhuma</span>
                <span>Máxima</span>
              </div>
              <p className="panel-hint">{COMPRESSION_LABELS[exportSettings.compression].hint}</p>
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
                  {background.aspect !== 'native' && ` · ${FRAME_ASPECT_LABELS[background.aspect]}`}
                </dd>
              </div>
              <div>
                <dt>Formato</dt>
                <dd>MP4 · {plan.codec === 'hevc' ? 'HEVC' : 'H.264'} · {plan.fps} fps</dd>
              </div>
              <div>
                <dt>Tamanho estimado</dt>
                <dd>≈ {formatBytes(estimatedFileBytes(plan, withAudio))}</dd>
              </div>
            </dl>

            <div className="dialog-field">
              <span className="dialog-label">Exportar também para</span>
              <div className="batch-list">
                {PLATFORM_PRESETS.filter((preset) => preset.id !== exportSettings.preset).map((preset) => (
                  <label key={preset.id} className="check">
                    <input type="checkbox" checked={batch.has(preset.id)} onChange={() => toggleBatch(preset.id)} />
                    <span>{preset.label}</span>
                  </label>
                ))}
              </div>
              <p className="panel-hint">Um arquivo a mais por plataforma, no formato dela.</p>
            </div>

            <div className="dialog-actions">
              <button className="panel-button" onClick={onClose}>
                Cancelar
              </button>
              <button className="panel-button panel-button-primary" onClick={() => void run()}>
                {batchCount > 0 ? `Exportar ${batchCount + 1} arquivos` : 'Exportar MP4'}
              </button>
            </div>
          </>
        )}

        {rendering && (
          <>
            <p className="panel-hint">
              {phase.total > 1 && `Arquivo ${phase.item} de ${phase.total} · ${phase.label} · `}
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

        {(phase.kind === 'done' || phase.kind === 'failed') && phase.results.length > 0 && (
          <div className="dialog-results">
            {phase.results.map((result) => (
              <p key={result.exportId} className="dialog-result">
                <strong>{result.fileName}</strong>
                <span className="panel-hint">{formatBytes(result.sizeBytes)}</span>
              </p>
            ))}
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="dialog-actions">
            {features.revealExport && (
              <button
                className="panel-button"
                onClick={() => void window.screenrx.export.reveal((phase.results[phase.results.length - 1] as ExportResult).exportId)}
              >
                Mostrar no Finder
              </button>
            )}
            <button className="panel-button panel-button-primary" onClick={onClose}>
              Concluir
            </button>
          </div>
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
