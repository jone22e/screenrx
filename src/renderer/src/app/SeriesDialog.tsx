import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatClock } from '@shared/format'
import type { AppError } from '@shared/models/errors'
import type { RecordingSummary } from '@shared/models/session'
import type { SeriesPlan, SeriesProgress } from '@shared/models/series'
import { SERIES_LIMITS } from '@shared/models/series'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import { SparklesIcon, TrashIcon } from './icons'

interface Props {
  recording: RecordingSummary
  onClose: () => void
}

type Phase = { kind: 'brief' } | { kind: 'planning' } | { kind: 'plan'; plan: SeriesPlan } | { kind: 'splitting'; plan: SeriesPlan; progress: SeriesProgress | null }

const TARGET_LABELS: Record<(typeof SERIES_LIMITS.targetChoicesSec)[number], string> = { 60: '1 min', 180: '3 min', 300: '5 min', 600: '10 min' }

/**
 * One recording becomes a series: the AI reads the transcript and proposes
 * the episodes, the user looks them over (names, series' name), and each is
 * then cut out as a recording of its own. The source stays as it is.
 */
export function SeriesDialog({ recording, onClose }: Props) {
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const [targetSec, setTargetSec] = useState<number>(180)
  const [phase, setPhase] = useState<Phase>({ kind: 'brief' })
  const [error, setError] = useState<AppError | null>(null)
  useEffect(() => {
    void aiSettings.load()
  }, [])
  // While the episodes are being cut, the main process says which one it is on.
  useEffect(() => {
    if (phase.kind !== 'splitting') return
    return window.screenrx.library.onSplitProgress((progress) => {
      if (progress.sessionId === recording.id) setPhase((current) => (current.kind === 'splitting' ? { ...current, progress } : current))
    })
  }, [phase.kind, recording.id])

  const plan = (): void => {
    if (!current) return
    setError(null)
    setPhase({ kind: 'planning' })
    void window.screenrx.library.planSeries(recording.id, current.choice, targetSec).then((result) => {
      if (result.ok) setPhase({ kind: 'plan', plan: result.value })
      else {
        setPhase({ kind: 'brief' })
        if (result.error.code !== 'ai-cancelled') setError(result.error)
      }
    })
  }

  const split = (): void => {
    if (phase.kind !== 'plan') return
    const ready = { ...phase.plan, episodes: phase.plan.episodes.map((episode, index) => ({ ...episode, title: episode.title.trim() || `Episódio ${index + 1}` })) }
    setError(null)
    setPhase({ kind: 'splitting', plan: ready, progress: null })
    void window.screenrx.library.splitSeries(recording.id, ready).then((result) => {
      if (result.ok) onClose()
      else {
        setPhase({ kind: 'plan', plan: ready })
        setError(result.error)
      }
    })
  }

  const busy = phase.kind === 'planning' || phase.kind === 'splitting'
  const edit = (change: (plan: SeriesPlan) => SeriesPlan): void => setPhase((current) => (current.kind === 'plan' ? { kind: 'plan', plan: change(current.plan) } : current))

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog series-dialog" role="dialog" aria-modal="true" aria-label="Gerar série">
        <h2 className="dialog-title">Gerar série</h2>
        <p className="panel-hint">
          <strong>{recording.title}</strong> · {formatClock(recording.durationMs)}. A IA lê a transcrição e divide a gravação em episódios; cada um vira uma
          gravação da série, pronta para editar e publicar. A gravação original continua na biblioteca.
        </p>

        {(phase.kind === 'brief' || phase.kind === 'planning') && (
          <>
            <div className="series-field">
              <span className="series-label">Duração de cada episódio</span>
              <div className="chips" role="radiogroup" aria-label="Duração de cada episódio">
                {SERIES_LIMITS.targetChoicesSec.map((seconds) => (
                  <button key={seconds} className="chip chip-small" role="radio" aria-checked={targetSec === seconds} disabled={busy} onClick={() => setTargetSec(seconds)}>
                    {TARGET_LABELS[seconds]}
                  </button>
                ))}
              </div>
            </div>
            {ai.providers !== null && !current && (
              <p className="panel-hint">
                Nenhuma ferramenta de IA pronta.{' '}
                <button className="panel-button panel-button-small" onClick={openSettings}>
                  Configurar IA
                </button>
              </p>
            )}
            {phase.kind === 'planning' && <p className="panel-hint series-working">A IA está lendo a transcrição e separando os episódios…</p>}
          </>
        )}

        {(phase.kind === 'plan' || phase.kind === 'splitting') && (
          <>
            <label className="series-field">
              <span className="series-label">Nome da série</span>
              <input
                className="series-name"
                type="text"
                value={phase.plan.seriesTitle}
                maxLength={SERIES_LIMITS.maxTitleLength}
                disabled={busy}
                onChange={(event) => edit((plan) => ({ ...plan, seriesTitle: event.target.value }))}
              />
            </label>
            <ol className="episode-list">
              {phase.plan.episodes.map((episode, index) => (
                <li key={`${episode.startMs}-${index}`} className="episode-row">
                  <span className="episode-number">{index + 1}</span>
                  <input
                    className="episode-title"
                    type="text"
                    value={episode.title}
                    maxLength={SERIES_LIMITS.maxTitleLength}
                    aria-label={`Título do episódio ${index + 1}`}
                    disabled={busy}
                    onChange={(event) => edit((plan) => ({ ...plan, episodes: plan.episodes.map((entry, at) => (at === index ? { ...entry, title: event.target.value } : entry)) }))}
                  />
                  <span className="episode-time">
                    {formatClock(episode.startMs)} · {formatClock(episode.endMs - episode.startMs)}
                  </span>
                  {/* Removing an episode gives its stretch to the one before, so nothing of the recording is lost. */}
                  <button
                    className="icon-button"
                    aria-label="Juntar ao anterior"
                    title="Juntar este trecho ao episódio anterior"
                    disabled={busy || index === 0}
                    onClick={() =>
                      edit((plan) => ({
                        ...plan,
                        episodes: plan.episodes.flatMap((entry, at) => (at === index ? [] : at === index - 1 ? [{ ...entry, endMs: episode.endMs }] : [entry]))
                      }))
                    }
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ol>
            {phase.kind === 'splitting' && (
              <p className="panel-hint series-working">
                {phase.progress && phase.progress.done < phase.progress.total
                  ? `Cortando o episódio ${phase.progress.done + 1} de ${phase.progress.total}: ${phase.progress.title}…`
                  : 'Preparando os episódios…'}{' '}
                O vídeo de cada um é recodificado, o que leva um tempo para gravações longas.
              </p>
            )}
          </>
        )}

        {error && (
          <p className="dialog-error" role="alert">
            {error.message}
          </p>
        )}

        <div className="dialog-actions">
          {phase.kind === 'planning' ? (
            <button className="panel-button" onClick={() => void window.screenrx.ai.cancel()}>
              Cancelar
            </button>
          ) : (
            <button className="panel-button" disabled={phase.kind === 'splitting'} onClick={onClose}>
              {phase.kind === 'plan' ? 'Descartar' : 'Cancelar'}
            </button>
          )}
          {phase.kind === 'plan' && (
            <button className="panel-button" onClick={() => setPhase({ kind: 'brief' })}>
              Planejar de novo
            </button>
          )}
          {(phase.kind === 'brief' || phase.kind === 'planning') && (
            <button className="panel-button panel-button-primary" disabled={busy || !current} onClick={plan}>
              <SparklesIcon /> Planejar episódios
            </button>
          )}
          {(phase.kind === 'plan' || phase.kind === 'splitting') && (
            <button className="panel-button panel-button-primary" disabled={busy || phase.plan.seriesTitle.trim() === ''} onClick={split}>
              Criar {phase.plan.episodes.length === 1 ? '1 episódio' : `${phase.plan.episodes.length} episódios`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
