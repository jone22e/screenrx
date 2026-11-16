import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WORKER_SPECS } from '@engine/ai/workerPrompts'
import { PLATFORM_PRESETS } from '@engine/export/platformPresets'
import { formatTimecode } from '@shared/format'
import type { AutoEditBrief, AutoEditResult, AutoEditStage, WorkerResult, WorkerRole } from '@shared/models/autoEdit'
import { WORKER_ROLES } from '@shared/models/autoEdit'
import type { CaptionLanguage, ExportPreset } from '@shared/models/project'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { agentCursors } from '../common/agentCursors'
import { openSettings } from '../common/settingsScreen'
import { editStateOf } from './AssistantPanel'
import type { EditorStore } from './EditorStore'
import { GearIcon, RefreshIcon, SparklesIcon, UndoIcon } from './icons'

interface Props {
  store: EditorStore
  onClose: () => void
}

type Phase =
  | { kind: 'brief' }
  | { kind: 'working' }
  | { kind: 'done'; result: AutoEditResult }
  | { kind: 'failed'; message: string }

/** Which lane each kind of action lands on, for the cursors. */
const LANE_OF: Partial<Record<string, string>> = {
  cut: '.lane-trim',
  uncut: '.lane-trim',
  'speed-region': '.lane-speed',
  zoom: '.lane-zoom',
  'remove-zoom': '.lane-zoom',
  text: '.lane-text',
  captions: '.lane-caption',
  'caption-mode': '.lane-caption',
  'caption-length': '.lane-caption',
  'caption-animation': '.lane-caption',
  'caption-language': '.lane-caption'
}

/** How long the cursors take to show an agent's work, at most. */
const SHOW_MS = 2000
const STEP_MS = 60

const ROLE_HINTS: Record<WorkerRole, string> = {
  cutter: 'cortes e velocidade',
  camera: 'zoom, formato e enquadramento',
  captioner: 'legendas e títulos',
  sound: 'volumes e música',
  art: 'fundo e exportação'
}

/**
 * "Editar com IA": the user says where the video goes and what it should
 * feel like; a director plans and a team of agents edits in parallel; the
 * work is applied one undo step per agent while their cursors sweep the
 * timeline; then each agent's work can be taken back or done again.
 */
export function AutoEditDialog({ store, onClose }: Props) {
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const [phase, setPhase] = useState<Phase>({ kind: 'brief' })
  const [brief, setBrief] = useState<AutoEditBrief>(() => ({
    preset: store.getState().exportSettings.preset === 'custom' ? 'reels' : store.getState().exportSettings.preset,
    targetDurationSec: null,
    tone: '',
    roles: [...WORKER_ROLES]
  }))
  const [stages, setStages] = useState<Partial<Record<WorkerRole | 'director', { stage: AutoEditStage; elapsedMs: number }>>>({})
  const [rerun, setRerun] = useState<{ role: WorkerRole; instruction: string; busy: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const { session } = store
  const hasTranscript = store.getState().transcript !== null

  useEffect(() => {
    void aiSettings.load()
    const stop = window.screenrx.ai.onAutoEditProgress((progress) => {
      if (progress.sessionId !== session.sessionId) return
      setStages((previous) => ({ ...previous, [progress.who]: { stage: progress.stage, elapsedMs: progress.elapsedMs } }))
    })
    return () => {
      stop()
      for (const timer of timers.current) clearTimeout(timer)
      agentCursors.clear()
    }
  }, [session.sessionId])

  const translate = (language: CaptionLanguage): void => {
    if (!current) return
    const { choice } = current
    void store.translateCaptions(language, (target, cues, sourceLocale) =>
      window.screenrx.captions.translate({ language: target, cues, sourceLocale }, choice)
    )
  }

  /** The agents' cursors sweep over what they did, all at once, within two seconds. */
  const show = (workers: readonly WorkerResult[]): void => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
    for (const worker of workers) {
      const spec = WORKER_SPECS[worker.role]
      const steps = worker.actions.filter(({ action }) => 'startMs' in action)
      if (steps.length === 0) continue
      const stepMs = Math.min(STEP_MS, SHOW_MS / steps.length)
      steps.forEach(({ action, reason }, index) => {
        timers.current.push(
          setTimeout(() => {
            agentCursors.move({
              role: worker.role,
              timeMs: 'startMs' in action ? action.startMs : 0,
              lane: LANE_OF[action.type] ?? '.ruler',
              label: `${spec.label}${reason ? ` · ${reason}` : ''}`,
              color: spec.color
            })
          }, index * stepMs)
        )
      })
      timers.current.push(setTimeout(() => agentCursors.remove(worker.role), steps.length * stepMs + 1500))
    }
  }

  const run = async (): Promise<void> => {
    if (!current) return
    setStages({})
    setNotice(null)
    setPhase({ kind: 'working' })
    const result = await window.screenrx.ai.autoEdit(session.sessionId, { brief, edit: editStateOf(store) }, current.choice).catch(() => null)
    if (!result?.ok) {
      setPhase(result?.error.code === 'ai-cancelled' ? { kind: 'brief' } : { kind: 'failed', message: result?.error.message ?? 'A IA não respondeu.' })
      return
    }
    store.applyAutoEdit(result.value.workers.map((worker) => ({ role: worker.role, actions: worker.actions.map((entry) => entry.action) })), translate)
    show(result.value.workers)
    setPhase({ kind: 'done', result: result.value })
  }

  const undoWorker = (role: WorkerRole): void => {
    if (!store.undoWorker(role, translate)) {
      setNotice('Algo foi editado depois da equipe: use ⌘Z para voltar passo a passo.')
      return
    }
    setPhase((previous) =>
      previous.kind === 'done'
        ? { kind: 'done', result: { ...previous.result, workers: previous.result.workers.map((worker) => (worker.role === role ? { ...worker, actions: [], notes: 'Desfeito.' } : worker)) } }
        : previous
    )
  }

  const rerunWorker = async (): Promise<void> => {
    if (!rerun || !current || phase.kind !== 'done') return
    setRerun({ ...rerun, busy: true })
    setNotice(null)
    const result = await window.screenrx.ai
      .autoEditRerun(session.sessionId, { brief, edit: editStateOf(store), role: rerun.role, plan: phase.result.plan, instruction: rerun.instruction }, current.choice)
      .catch(() => null)
    if (!result?.ok) {
      setRerun(null)
      setNotice(result?.error.message ?? 'A IA não respondeu.')
      return
    }
    if (!store.replaceWorker(rerun.role, result.value.actions.map((entry) => entry.action), translate)) {
      setRerun(null)
      setNotice('Algo foi editado depois da equipe: desfaça com ⌘Z antes de refazer um agente.')
      return
    }
    show([result.value])
    setPhase({ kind: 'done', result: { ...phase.result, workers: phase.result.workers.map((worker) => (worker.role === rerun.role ? result.value : worker)) } })
    setRerun(null)
  }

  const toggleRole = (role: WorkerRole): void =>
    setBrief((previous) => ({ ...previous, roles: previous.roles.includes(role) ? previous.roles.filter((entry) => entry !== role) : [...previous.roles, role] }))

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-label="Editar com IA">
        <h2 className="dialog-title">
          <SparklesIcon /> Editar com IA
        </h2>

        {phase.kind === 'brief' && (
          <>
            {!current && (
              <div className="dialog-field">
                <p className="panel-hint">A edição automática precisa de uma ferramenta de IA configurada.</p>
                <button className="panel-button" onClick={openSettings}>
                  <GearIcon /> Configurar IA
                </button>
              </div>
            )}
            {!hasTranscript && (
              <p className="dialog-warning">Sem legendas geradas, a equipe não sabe o que foi dito: só cortes por silêncio e zooms pelos cliques saem bem. Gere as legendas antes para um resultado melhor.</p>
            )}
            <div className="dialog-field">
              <span className="dialog-label">Para onde vai</span>
              <div className="presets" role="radiogroup" aria-label="Plataforma">
                {PLATFORM_PRESETS.map((preset) => (
                  <button key={preset.id} className="preset" role="radio" aria-checked={brief.preset === preset.id} title={preset.hint} onClick={() => setBrief({ ...brief, preset: preset.id })}>
                    {preset.label}
                  </button>
                ))}
                <button className="preset" role="radio" aria-checked={brief.preset === 'custom'} onClick={() => setBrief({ ...brief, preset: 'custom' as ExportPreset })}>
                  Sem rede
                </button>
              </div>
            </div>
            <div className="dialog-field">
              <span className="dialog-label">Duração alvo</span>
              <div className="chips" role="radiogroup" aria-label="Duração alvo">
                {[null, 30, 60, 90, 180].map((seconds) => (
                  <button key={String(seconds)} className="chip" role="radio" aria-checked={brief.targetDurationSec === seconds} onClick={() => setBrief({ ...brief, targetDurationSec: seconds })}>
                    {seconds === null ? 'Livre' : seconds < 60 ? `${seconds} s` : `${seconds / 60} min`}
                  </button>
                ))}
              </div>
              <p className="panel-hint">A gravação tem {formatTimecode(session.durationMs)}. O Cortador tenta chegar perto do alvo sem perder o que é dito uma vez só.</p>
            </div>
            <div className="dialog-field">
              <span className="dialog-label">Tom</span>
              <input
                className="text-input"
                aria-label="Tom do vídeo"
                placeholder="tutorial direto, bastidores descontraído, anúncio de recurso…"
                maxLength={200}
                value={brief.tone}
                onChange={(event) => setBrief({ ...brief, tone: event.target.value })}
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-label">Equipe</span>
              <div className="batch-list">
                {WORKER_ROLES.map((role) => (
                  <label key={role} className="check" title={ROLE_HINTS[role]}>
                    <input type="checkbox" checked={brief.roles.includes(role)} onChange={() => toggleRole(role)} />
                    <span>
                      <span className="agent-dot" style={{ background: WORKER_SPECS[role].color }} /> {WORKER_SPECS[role].label}
                    </span>
                  </label>
                ))}
              </div>
              <p className="panel-hint">
                Um Diretor lê a gravação e escreve o plano; os agentes marcados editam ao mesmo tempo, cada um nas suas pistas. Cada agente é um passo de desfazer. Só texto sai do Mac: a transcrição, os cliques por trecho e o estado da edição.
              </p>
            </div>
            <div className="dialog-actions">
              <button className="panel-button" onClick={onClose}>
                Cancelar
              </button>
              <button className="panel-button panel-button-primary" disabled={!current || brief.roles.length === 0} onClick={() => void run()}>
                <SparklesIcon /> Editar
              </button>
            </div>
          </>
        )}

        {phase.kind === 'working' && (
          <>
            <ul className="agent-list">
              <AgentRow label="Diretor" color="#ffffff" hint="lê a gravação e escreve o plano" stage={stages.director} />
              {brief.roles.map((role) => (
                <AgentRow key={role} label={WORKER_SPECS[role].label} color={WORKER_SPECS[role].color} hint={ROLE_HINTS[role]} stage={stages[role]} />
              ))}
            </ul>
            <p className="panel-hint">O Diretor pensa primeiro; depois os agentes correm em paralelo. Costuma levar de 30 s a 1 min.</p>
            <div className="dialog-actions">
              <button className="panel-button" onClick={() => void window.screenrx.ai.cancel()}>
                Cancelar
              </button>
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <p className="panel-hint">{phase.result.plan.summary || 'Plano feito.'}</p>
            {phase.result.plan.chapters.length > 0 && (
              <p className="panel-hint">
                Capítulos: {phase.result.plan.chapters.map((chapter) => `${chapter.title || 'sem nome'} (${formatTimecode(chapter.startMs)})`).join(' · ')}
              </p>
            )}
            <ul className="agent-list">
              {phase.result.workers.map((worker) => {
                const spec = WORKER_SPECS[worker.role]
                return (
                  <li key={worker.role} className="agent-row agent-row-done">
                    <span className="agent-dot" style={{ background: spec.color }} />
                    <span className="agent-main">
                      <strong>{spec.label}</strong>
                      <span className="agent-notes">{worker.error ?? worker.notes ?? ''}</span>
                      {worker.actions.length > 0 && (
                        <ul className="agent-actions">
                          {worker.actions.map((entry, index) => (
                            <li key={index}>
                              {'startMs' in entry.action ? `${formatTimecode(entry.action.startMs)} · ` : ''}
                              {describeAction(entry.action)}
                              {entry.reason && <span className="agent-reason"> — {entry.reason}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </span>
                    <span className="agent-tools">
                      <span className="agent-count">{worker.actions.length} {worker.actions.length === 1 ? 'ação' : 'ações'}</span>
                      <button className="region-row-remove" aria-label={`Desfazer o ${spec.label}`} title="Desfazer só este agente" disabled={worker.actions.length === 0 || !store.canUndoWorker(worker.role)} onClick={() => undoWorker(worker.role)}>
                        <UndoIcon />
                      </button>
                      <button className="region-row-remove" aria-label={`Refazer o ${spec.label}`} title="Refazer este agente com uma instrução" disabled={rerun !== null} onClick={() => setRerun({ role: worker.role, instruction: '', busy: false })}>
                        <RefreshIcon />
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
            {rerun && (
              <div className="dialog-field">
                <span className="dialog-label">Refazer o {WORKER_SPECS[rerun.role].label} com…</span>
                <div className="cut-actions">
                  <input
                    className="text-input"
                    aria-label="Instrução para o agente"
                    placeholder="corta menos no começo; zoom só nos menus…"
                    autoFocus
                    maxLength={500}
                    disabled={rerun.busy}
                    value={rerun.instruction}
                    onChange={(event) => setRerun({ ...rerun, instruction: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void rerunWorker()
                      if (event.key === 'Escape') setRerun(null)
                      event.stopPropagation()
                    }}
                  />
                  <button className="panel-button panel-button-primary" disabled={rerun.busy} onClick={() => void rerunWorker()}>
                    {rerun.busy ? 'Refazendo…' : 'Refazer'}
                  </button>
                  <button className="panel-button" disabled={rerun.busy} onClick={() => setRerun(null)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
            {notice && <p className="dialog-warning">{notice}</p>}
            <div className="dialog-actions">
              <button className="panel-button" onClick={() => setPhase({ kind: 'brief' })}>
                Editar de novo
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
              <button className="panel-button panel-button-primary" onClick={() => setPhase({ kind: 'brief' })}>
                Tentar de novo
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function AgentRow({ label, color, hint, stage }: { label: string; color: string; hint: string; stage: { stage: AutoEditStage; elapsedMs: number } | undefined }) {
  const text = !stage ? 'aguardando' : stage.stage === 'thinking' ? 'pensando…' : stage.stage === 'done' ? `pronto em ${(stage.elapsedMs / 1000).toFixed(0)} s` : 'falhou'
  return (
    <li className="agent-row" data-stage={stage?.stage ?? 'waiting'}>
      <span className="agent-dot" style={{ background: color }} />
      <span className="agent-main">
        <strong>{label}</strong>
        <span className="agent-notes">{hint}</span>
      </span>
      <span className="agent-count">{text}</span>
    </li>
  )
}

/** One action in the user's words, for the review list. */
function describeAction(action: WorkerResult['actions'][number]['action']): string {
  switch (action.type) {
    case 'cut':
      return `corte até ${formatTimecode(action.endMs)}`
    case 'uncut':
      return `desfaz cortes até ${formatTimecode(action.endMs)}`
    case 'speed-region':
      return `${String(action.speed).replace('.', ',')}× até ${formatTimecode(action.endMs)}`
    case 'speed':
      return `velocidade ${String(action.speed).replace('.', ',')}×`
    case 'zoom':
      return `zoom${action.scale ? ` ${String(action.scale).replace('.', ',')}×` : ''} até ${formatTimecode(action.endMs)}`
    case 'remove-zoom':
      return 'remove zooms'
    case 'text':
      return `texto “${action.text}”`
    case 'captions':
      return action.visible ? 'mostra legendas' : 'oculta legendas'
    case 'caption-mode':
      return `legendas: ${action.mode}`
    case 'caption-length':
      return `legendas: ${action.length}`
    case 'caption-animation':
      return `legendas: animação ${action.animation}`
    case 'caption-language':
      return `legendas em ${action.language ?? 'original'}`
    case 'background':
      return `fundo ${action.presetId ?? 'nenhum'}`
    case 'format':
      return `formato ${action.aspect}`
    case 'export-preset':
      return `exportação para ${action.preset}`
    case 'framing':
      return `enquadramento ${action.fit}`
    case 'webcam':
      return action.visible ? 'mostra câmera' : 'oculta câmera'
    case 'mute':
      return `${action.muted ? 'silencia' : 'ativa'} ${action.track}`
    case 'volume':
      return `${action.track} a ${Math.round(action.volume * 100)}%`
    case 'music-ducking':
      return `música abaixa: ${action.ducking}`
    default:
      return (action as { type: string }).type
  }
}
