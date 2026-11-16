import { useEffect, useState } from 'react'
import { WORKER_SPECS } from '@engine/ai/workerPrompts'
import type { AutoEditStage, WorkerRole } from '@shared/models/autoEdit'
import { WORKER_ROLES } from '@shared/models/autoEdit'
import type { EpisodeEntry, SeriesAutoEditState } from './seriesAutoEdit'
import { seriesAutoEdit } from './seriesAutoEdit'

interface Props {
  run: SeriesAutoEditState
}

const STATUS_LABELS: Record<EpisodeEntry['status'], string> = {
  queued: 'na fila',
  editing: 'editando…',
  done: 'editado',
  failed: 'falhou',
  cancelled: 'cancelado'
}

const STAGE_LABELS: Record<AutoEditStage, string> = { thinking: 'trabalhando', done: 'pronto', failed: 'falhou' }

/**
 * The team's progress through a series, under the shelf's heading: which
 * episode it is on and what each agent is doing, one line per episode, and
 * Cancelar while it works. Stays until closed once done.
 */
export function SeriesEditStatus({ run }: Props) {
  const working = run.phase === 'working'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [working])
  const seconds = Math.max(0, Math.round(((run.finishedAt ?? now) - run.startedAt) / 1000))
  const done = run.episodes.filter((episode) => episode.status === 'done').length
  const failed = run.episodes.filter((episode) => episode.status === 'failed').length
  const at = run.episodes.findIndex((episode) => episode.status === 'editing')
  const current = at >= 0 ? run.episodes[at] : null

  const headline = working
    ? current
      ? `Editando ${at + 1} de ${run.episodes.length}: ${current.title} · ${seconds} s`
      : `Preparando… · ${seconds} s`
    : run.phase === 'cancelled'
      ? `Cancelado · ${done === 1 ? '1 episódio editado' : `${done} episódios editados`}`
      : `Pronto em ${seconds} s · ${done === 1 ? '1 episódio editado' : `${done} episódios editados`}${failed > 0 ? ` · ${failed} ${failed === 1 ? 'falhou' : 'falharam'}` : ''}`

  return (
    <div className="series-edit" data-phase={run.phase} role="status">
      <div className="series-edit-head">
        <span className="series-edit-headline">{headline}</span>
        {working ? (
          <button className="panel-button panel-button-small" onClick={() => seriesAutoEdit.cancel()}>
            Cancelar
          </button>
        ) : (
          <button className="panel-button panel-button-small" onClick={() => seriesAutoEdit.dismiss()}>
            Fechar
          </button>
        )}
      </div>
      {working && run.current && (
        <ul className="series-edit-agents" aria-label="Agentes">
          <li data-stage={run.current.stages.director ?? 'waiting'}>
            <span className="agent-dot" style={{ background: 'var(--accent)' }} />
            Diretor <span className="series-edit-stage">{run.current.stages.director ? STAGE_LABELS[run.current.stages.director] : 'na fila'}</span>
          </li>
          {WORKER_ROLES.filter((role) => run.current?.stages[role] !== undefined).map((role: WorkerRole) => {
            const stage = run.current?.stages[role] as AutoEditStage
            return (
              <li key={role} data-stage={stage}>
                <span className="agent-dot" style={{ background: WORKER_SPECS[role].color }} />
                {WORKER_SPECS[role].label} <span className="series-edit-stage">{STAGE_LABELS[stage]}</span>
              </li>
            )
          })}
        </ul>
      )}
      <ol className="series-edit-list">
        {run.episodes.map((episode, index) => (
          <li key={episode.id} data-status={episode.status} title={episode.error ?? undefined}>
            <span className="episode-number">{index + 1}</span>
            <span className="series-edit-title">{episode.title}</span>
            <span className="series-edit-state">
              {episode.status === 'done' && episode.actions > 0 ? `${episode.actions} ${episode.actions === 1 ? 'ação' : 'ações'}` : STATUS_LABELS[episode.status]}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
