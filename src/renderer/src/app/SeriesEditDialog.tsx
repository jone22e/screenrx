import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatClock } from '@shared/format'
import type { AutoEditBrief } from '@shared/models/autoEdit'
import type { RecordingSummary } from '@shared/models/session'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import { AutoEditBriefForm, defaultBrief } from '../editor/AutoEditBriefForm'
import { SparklesIcon } from './icons'
import { seriesAutoEdit } from './seriesAutoEdit'

interface Props {
  series: string
  /** The series' recordings, in the order they are watched. */
  episodes: RecordingSummary[]
  onClose: () => void
}

/**
 * "Editar todos com IA" from a shelf: one brief for the whole series, then
 * the team goes through the episodes one after the other, with the
 * progress shown on the shelf itself.
 */
export function SeriesEditDialog({ series, episodes, onClose }: Props) {
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const [brief, setBrief] = useState<AutoEditBrief>(() => defaultBrief())
  useEffect(() => {
    void aiSettings.load()
  }, [])
  const ready = episodes.filter((episode) => episode.status === 'completed')

  const start = (): void => {
    if (!current || ready.length === 0) return
    void seriesAutoEdit.start(
      series,
      ready.map((episode) => ({ id: episode.id, title: episode.title })),
      brief,
      current.choice
    )
    onClose()
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog series-dialog" role="dialog" aria-modal="true" aria-label="Editar todos com IA">
        <h2 className="dialog-title">Editar todos com IA</h2>
        <p className="panel-hint">
          <strong>{series}</strong> · {ready.length === 1 ? '1 episódio' : `${ready.length} episódios`}. Um Diretor e uma equipe de agentes editam cada
          episódio, um depois do outro, com o mesmo briefing. A edição fica guardada em cada um, para rever no editor; ⌘Z lá desfaz a equipe inteira.
        </p>
        <ol className="episode-list series-edit-episodes">
          {ready.map((episode, index) => (
            <li key={episode.id} className="episode-row">
              <span className="episode-number">{index + 1}</span>
              <span className="episode-name">{episode.title}</span>
              <span className="episode-time">{formatClock(episode.durationMs)}</span>
              <span />
            </li>
          ))}
        </ol>
        {ai.providers !== null && !current && (
          <p className="panel-hint">
            Nenhuma ferramenta de IA pronta.{' '}
            <button className="panel-button panel-button-small" onClick={openSettings}>
              Configurar IA
            </button>
          </p>
        )}
        <AutoEditBriefForm brief={brief} onChange={setBrief} />
        <p className="panel-hint">Só texto sai do Mac: a transcrição, os cliques e o estado da edição de cada episódio.</p>
        <div className="dialog-actions">
          <button className="panel-button" onClick={onClose}>
            Cancelar
          </button>
          <button className="panel-button panel-button-primary" disabled={!current || ready.length === 0 || brief.roles.length === 0} onClick={start}>
            <SparklesIcon /> Editar {ready.length === 1 ? '1 episódio' : `${ready.length} episódios`}
          </button>
        </div>
      </div>
    </div>
  )
}
