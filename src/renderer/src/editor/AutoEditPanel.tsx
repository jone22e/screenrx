import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WORKER_SPECS } from '@engine/ai/workerPrompts'
import { formatTimecode } from '@shared/format'
import type { AssistantAction } from '@shared/models/assistant'
import type { AutoEditBrief, AutoEditPlan, AutoEditStage, WorkerResult, WorkerRole } from '@shared/models/autoEdit'
import type { CaptionLanguage } from '@shared/models/project'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { agentCursors } from '../common/agentCursors'
import { openSettings } from '../common/settingsScreen'
import { AutoEditBriefForm, ROLE_HINTS, defaultBrief } from './AutoEditBriefForm'
import { editStateOf } from './editState'
import type { EditorStore } from './EditorStore'
import { GearIcon, RefreshIcon, SparklesIcon, UndoIcon } from './icons'

interface Props {
  store: EditorStore
}

/** The toolbar's "Editar com IA" opens the panel's brief; this is how it says so. */
class AutoEditFocus {
  private at = 0
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getState = (): number => this.at
  open(): void {
    this.at = Date.now()
    for (const listener of this.listeners) listener()
  }
}
export const autoEditFocus = new AutoEditFocus()

type Phase = { kind: 'idle' } | { kind: 'brief' } | { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; message: string }

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

/** Each agent's actions go in this far apart, so the eye can follow its cursor; a long list still ends within a few seconds. */
const STEP_MS = 220
const MAX_SHOW_MS = 4000

/**
 * The editing team, in the assistant's panel, beside the preview and the
 * timeline: the brief, then each agent as it thinks and as its work lands
 * on the timeline one action at a time, its cursor on each — and after,
 * what each one did, to take back or do again on its own.
 */
export function AutoEditPanel({ store }: Props) {
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const focus = useSyncExternalStore(autoEditFocus.subscribe, autoEditFocus.getState)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [brief, setBrief] = useState<AutoEditBrief>(() => defaultBrief(store.getState().exportSettings.preset === 'custom' ? 'reels' : store.getState().exportSettings.preset))
  const [stages, setStages] = useState<Partial<Record<WorkerRole | 'director', { stage: AutoEditStage; elapsedMs: number }>>>({})
  const [plan, setPlan] = useState<AutoEditPlan | null>(null)
  const [results, setResults] = useState<WorkerResult[]>([])
  const [rerun, setRerun] = useState<{ role: WorkerRole; instruction: string; busy: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The agent whose details are shown. */
  const [open, setOpen] = useState<WorkerRole | null>(null)
  /** Seconds since the team started, shown while it works and as the final time. */
  const [elapsed, setElapsed] = useState<{ startedAt: number; now: number }>({ startedAt: 0, now: 0 })
  const clock = `${Math.max(0, Math.round((elapsed.now - elapsed.startedAt) / 1000))} s`
  const { session } = store
  const hasTranscript = store.getState().transcript !== null
  /** The agents still landing their work; the team is over when the answer is back and this is empty. */
  const landing = useRef<Promise<void>[]>([])
  const working = useRef(false)

  useEffect(() => {
    void aiSettings.load()
  }, [])

  // The clock ticks once a second while the team works.
  useEffect(() => {
    if (phase.kind !== 'working') return
    const timer = setInterval(() => setElapsed((previous) => ({ ...previous, now: Date.now() })), 1000)
    return () => clearInterval(timer)
  }, [phase.kind])

  // The toolbar button: show the brief (or the results), with the panel scrolled to it. A press not seen yet is taken during render.
  const root = useRef<HTMLDivElement>(null)
  const [seenFocus, setSeenFocus] = useState(focus)
  if (focus !== seenFocus) {
    setSeenFocus(focus)
    if (phase.kind === 'idle') setPhase({ kind: 'brief' })
  }
  useEffect(() => {
    if (focus !== 0) root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [focus])

  const translate = (language: CaptionLanguage): void => {
    if (!current) return
    const { choice } = current
    void store.translateCaptions(language, (target, cues, sourceLocale) =>
      window.screenrx.captions.translate({ language: target, cues, sourceLocale }, choice)
    )
  }

  /** One agent's work landing on the timeline, action by action, its cursor on each. Read through a ref by the listeners, which outlive a render. */
  const landRef = useRef<(result: WorkerResult) => Promise<void>>(() => Promise.resolve())
  const land = (result: WorkerResult): Promise<void> => {
    const spec = WORKER_SPECS[result.role]
    const stepMs = Math.min(STEP_MS, MAX_SHOW_MS / Math.max(1, result.actions.length))
    const reasons = result.actions.map((entry) => entry.reason)
    const promise = store
      .applyWorkerLive(
        result.role,
        result.actions.map((entry) => entry.action),
        translate,
        stepMs,
        (action: AssistantAction, index) => {
          agentCursors.move({
            role: result.role,
            timeMs: 'startMs' in action ? action.startMs : 0,
            lane: LANE_OF[action.type] ?? '.ruler',
            label: `${spec.label}${reasons[index] ? ` · ${reasons[index]}` : ''}`,
            color: spec.color
          })
        }
      )
      .then(() => {
        setTimeout(() => agentCursors.remove(result.role), 1200)
      })
    return promise
  }
  // Refs are written outside render; the listeners below read the latest `land`.
  useEffect(() => {
    landRef.current = land
  })

  useEffect(() => {
    const stops = [
      window.screenrx.ai.onAutoEditProgress((progress) => {
        if (progress.sessionId !== session.sessionId) return
        setStages((previous) => ({ ...previous, [progress.who]: { stage: progress.stage, elapsedMs: progress.elapsedMs } }))
      }),
      window.screenrx.ai.onAutoEditPlan((event) => {
        if (event.sessionId === session.sessionId && working.current) setPlan(event.plan)
      }),
      window.screenrx.ai.onAutoEditWorker((event) => {
        if (event.sessionId !== session.sessionId || !working.current) return
        setResults((previous) => [...previous.filter((entry) => entry.role !== event.result.role), event.result])
        landing.current.push(landRef.current(event.result))
      })
    ]
    return () => {
      for (const stop of stops) stop()
      agentCursors.clear()
    }
  }, [session.sessionId])

  const run = async (): Promise<void> => {
    if (!current) return
    setStages({})
    setPlan(null)
    setResults([])
    setNotice(null)
    setRerun(null)
    working.current = true
    landing.current = []
    setOpen(null)
    store.beginTeam()
    setPhase({ kind: 'working' })
    const startedAt = Date.now()
    setElapsed({ startedAt, now: startedAt })
    const answer = await window.screenrx.ai.autoEdit(session.sessionId, { brief, edit: editStateOf(store) }, current.choice).catch(() => null)
    await Promise.all(landing.current)
    working.current = false
    store.endTeam()
    setElapsed({ startedAt, now: Date.now() })
    if (!answer?.ok) {
      setPhase(answer?.error.code === 'ai-cancelled' ? { kind: 'brief' } : { kind: 'failed', message: answer?.error.message ?? 'A IA não respondeu.' })
      return
    }
    setPlan(answer.value.plan)
    setPhase({ kind: 'done' })
  }

  const undoWorker = (role: WorkerRole): void => {
    if (!store.undoWorker(role, translate)) {
      setNotice('Algo foi editado depois da equipe: use ⌘Z para voltar passo a passo.')
      return
    }
    setResults((previous) => previous.map((worker) => (worker.role === role ? { ...worker, actions: [], notes: 'Desfeito.' } : worker)))
  }

  const rerunWorker = async (): Promise<void> => {
    if (!rerun || !current || !plan) return
    setRerun({ ...rerun, busy: true })
    setNotice(null)
    const result = await window.screenrx.ai
      .autoEditRerun(session.sessionId, { brief, edit: editStateOf(store), role: rerun.role, plan, instruction: rerun.instruction }, current.choice)
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
    setResults((previous) => previous.map((worker) => (worker.role === rerun.role ? result.value : worker)))
    setRerun(null)
  }

  if (phase.kind === 'idle') {
    return (
      <div ref={root} className="team team-idle">
        <button className="panel-button panel-button-primary" onClick={() => setPhase({ kind: 'brief' })}>
          <SparklesIcon /> Editar com IA
        </button>
        <p className="panel-hint">Um Diretor e uma equipe de agentes editam o vídeo inteiro, à vista.</p>
      </div>
    )
  }

  const thinking = brief.roles.filter((role) => stages[role]?.stage === 'thinking').length
  const headline =
    phase.kind === 'working'
      ? stages.director?.stage !== 'done'
        ? `Diretor lendo a gravação · ${clock}`
        : thinking > 0
          ? `${thinking} ${thinking === 1 ? 'agente trabalhando' : 'agentes trabalhando'} · ${clock}`
          : `Aplicando · ${clock}`
      : phase.kind === 'done'
        ? `Pronto em ${clock}`
        : phase.kind === 'failed'
          ? 'Falhou'
          : ''

  return (
    <div ref={root} className="team" data-phase={phase.kind}>
      <div className="team-head">
        <h3 className="team-title">
          <SparklesIcon /> Equipe de edição
        </h3>
        {headline && <span className="team-status">{headline}</span>}
      </div>

      {phase.kind === 'brief' && (
        <>
          {ai.providers !== null && !current && (
            <>
              <p className="panel-hint">A edição automática precisa de uma ferramenta de IA configurada.</p>
              <button className="panel-button" onClick={openSettings}>
                <GearIcon /> Configurar IA
              </button>
            </>
          )}
          {!hasTranscript && (
            <p className="dialog-warning">Sem legendas geradas, a equipe não sabe o que foi dito: gere as legendas antes para um resultado melhor.</p>
          )}
          <AutoEditBriefForm brief={brief} onChange={setBrief} durationMs={session.durationMs} />
          <div className="cut-actions">
            <button
              className="panel-button panel-button-primary"
              disabled={!current || brief.roles.length === 0}
              title="Só texto sai do Mac. ⌘Z desfaz a equipe inteira."
              onClick={() => void run()}
            >
              <SparklesIcon /> Editar
            </button>
            <button className="panel-button" onClick={() => setPhase({ kind: 'idle' })}>
              Cancelar
            </button>
          </div>
        </>
      )}

      {(phase.kind === 'working' || phase.kind === 'done' || phase.kind === 'failed') && (
        <>
          <ul className="agent-list">
            {brief.roles.map((role) => {
              const result = results.find((entry) => entry.role === role) ?? null
              const spec = WORKER_SPECS[role]
              const stage = stages[role]?.stage ?? 'waiting'
              const isOpen = open === role
              return (
                <li key={role} className="agent-row" data-stage={result ? 'landed' : stage} data-open={isOpen}>
                  <button className="agent-line" onClick={() => setOpen(isOpen ? null : role)} aria-expanded={isOpen}>
                    <span className="agent-dot" style={{ background: spec.color }} />
                    <span className="agent-name">{spec.label}</span>
                    <span className="agent-hint">{ROLE_HINTS[role]}</span>
                    <span className="agent-state">{stageText(stages[role], result)}</span>
                  </button>
                  {isOpen && result && (
                    <div className="agent-details">
                      <p className="agent-notes">{result.error ?? result.notes}</p>
                      {result.actions.length > 0 && (
                        <ul className="agent-actions">
                          {result.actions.map((entry, index) => (
                            <li key={index}>
                              {'startMs' in entry.action ? <span className="agent-time">{formatTimecode(entry.action.startMs)}</span> : null}
                              <span>{describeAction(entry.action)}</span>
                              {entry.reason && <span className="agent-reason">{entry.reason}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {phase.kind === 'done' && (
                        <div className="agent-tools">
                          <button className="panel-button panel-button-small" disabled={result.actions.length === 0 || !store.canUndoWorker(role)} onClick={() => undoWorker(role)}>
                            <UndoIcon /> Desfazer este
                          </button>
                          <button className="panel-button panel-button-small" disabled={rerun !== null} onClick={() => setRerun({ role, instruction: '', busy: false })}>
                            <RefreshIcon /> Refazer com…
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {plan && (
            <p className="team-plan" title={plan.summary}>
              {plan.summary}
            </p>
          )}
          {phase.kind === 'working' && (
            <div className="cut-actions">
              <button className="panel-button" onClick={() => void window.screenrx.ai.cancel()}>
                Cancelar
              </button>
            </div>
          )}
          {phase.kind === 'failed' && (
            <p className="dialog-error" role="alert">
              {phase.message}
            </p>
          )}
          {rerun && (
            <div className="field">
              <span className="field-label">Refazer o {WORKER_SPECS[rerun.role].label} com…</span>
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
              <div className="cut-actions">
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
          {phase.kind !== 'working' && (
            <div className="cut-actions">
              <button className="panel-button" onClick={() => setPhase({ kind: 'brief' })}>
                Editar de novo
              </button>
              <button className="panel-button" onClick={() => setPhase({ kind: 'idle' })}>
                Fechar
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function stageText(stage: { stage: AutoEditStage; elapsedMs: number } | undefined, result: WorkerResult | null): string {
  if (result) return result.error ? 'falhou' : `${result.actions.length} ${result.actions.length === 1 ? 'ação' : 'ações'}`
  if (!stage) return 'na fila'
  if (stage.stage === 'thinking') return 'trabalhando…'
  if (stage.stage === 'done') return 'aplicando…'
  return 'falhou'
}

/** One action in the user's words, for the review list. */
function describeAction(action: AssistantAction): string {
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
