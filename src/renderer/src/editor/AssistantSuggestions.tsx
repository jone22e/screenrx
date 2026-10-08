import { useMemo, useSyncExternalStore } from 'react'
import { longPauses, totalMs } from '@engine/assistant/quickFixes'
import { DEFAULT_CAPTION_LOCALE } from '@shared/models/captions'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import type { EditorStore } from './EditorStore'

interface Props {
  store: EditorStore
}

/** One thing the assistant can do for this recording, as a card. */
interface Suggestion {
  id: string
  tone: 'cut' | 'zoom' | 'captions' | 'ai'
  title: string
  description: string
  /** The number that sizes it: "−1,6 s", "12 pontos". */
  metric: string
  state: 'ready' | 'busy' | 'done' | 'setup'
  action?: () => void
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

/**
 * What the assistant sees to do in this recording, worked out from the
 * recording itself, with no AI call: long pauses to cut, clicks to zoom on,
 * captions to generate, and the AI clean-up to run. Each is applied with
 * one click and can be undone like any edit.
 */
export function AssistantSuggestions({ store }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const { session } = store
  const transcript = state.transcript
  const words = useMemo(() => transcript?.words ?? [], [transcript])

  const pauses = useMemo(() => longPauses(words, state.trims), [words, state.trims])
  const everPauses = useMemo(() => longPauses(words, []), [words])
  const clicks = useMemo(
    () => session.interactions.filter((event) => event.type === 'click' || event.type === 'doubleClick' || event.type === 'rightClick').length,
    [session.interactions]
  )
  const autoZooms = state.zooms.filter((zoom) => zoom.mode === 'auto').length

  const suggestions: Suggestion[] = []

  if (words.length >= 2 && everPauses.length > 0) {
    const remaining = pauses.length > 0
    suggestions.push({
      id: 'pauses',
      tone: 'cut',
      title: remaining ? (pauses.length === 1 ? 'Remover pausa longa' : 'Remover pausas longas') : 'Pausas longas removidas',
      description: remaining
        ? `${pauses.length === 1 ? 'Um silêncio' : `${pauses.length} silêncios`} de mais de 1,5 s entre as falas.`
        : 'Os silêncios entre as falas já estão cortados.',
      metric: `−${seconds(totalMs(remaining ? pauses : everPauses))}`,
      state: remaining ? 'ready' : 'done',
      action: () => store.runAsOneStep(() => pauses.forEach((pause) => store.cutStretch(pause)))
    })
  }

  if (clicks > 0) {
    suggestions.push({
      id: 'auto-zoom',
      tone: 'zoom',
      title: 'Zoom automático nos cliques',
      description: 'Aproxima onde você clicou, 1,6×.',
      metric: autoZooms > 0 ? `${autoZooms} ${autoZooms === 1 ? 'zoom' : 'zooms'}` : `${clicks} ${clicks === 1 ? 'ponto' : 'pontos'}`,
      state: autoZooms > 0 ? 'done' : 'ready',
      action: () => store.regenerateAutoZooms()
    })
  }

  if (session.audio.length > 0) {
    const cues = state.captions.cues.length
    const track = session.audio.some((candidate) => candidate.kind === 'microphone') ? 'microphone' : 'systemAudio'
    suggestions.push({
      id: 'captions',
      tone: 'captions',
      title: 'Gerar legendas',
      description: 'Português (Brasil), estilo Clássica. A fala é reconhecida neste Mac.',
      metric: state.transcription ? 'Gerando…' : cues > 0 ? `${cues} ${cues === 1 ? 'trecho' : 'trechos'}` : 'pt-BR',
      state: state.transcription ? 'busy' : cues > 0 ? 'done' : 'ready',
      action: () =>
        void store.generateCaptions({ locale: DEFAULT_CAPTION_LOCALE, track }, (sessionId, request) =>
          window.screenrx.captions.generate(sessionId, request)
        )
    })
  }

  if (words.length > 0) {
    const proposals = state.suggestions.length
    suggestions.push({
      id: 'ai-cleanup',
      tone: 'ai',
      title: 'Limpar a fala com IA',
      description: current
        ? `Repetições, vícios de fala e trechos fora do assunto, com o ${current.provider.label}. Você decide um por um, na aba Cortes.`
        : 'Precisa de uma ferramenta de IA pronta neste Mac.',
      metric: state.suggesting ? 'Analisando…' : proposals > 0 ? `${proposals} ${proposals === 1 ? 'proposta' : 'propostas'}` : (current?.provider.label ?? 'IA'),
      state: !current ? 'setup' : state.suggesting ? 'busy' : proposals > 0 ? 'done' : 'ready',
      action: current
        ? () => void store.suggestCuts(current.choice, (sessionId, choice) => window.screenrx.ai.suggestCuts(sessionId, choice))
        : openSettings
    })
  }

  const open = suggestions.filter((suggestion) => suggestion.state === 'ready' || suggestion.state === 'setup').length

  return (
    <div className="assistant-suggestions">
      <p className="assistant-subtitle">
        {suggestions.length === 0
          ? 'Nada a sugerir para esta gravação.'
          : open === 0
            ? 'Tudo aplicado nesta gravação.'
            : `${open} ${open === 1 ? 'sugestão' : 'sugestões'} para esta gravação`}
      </p>
      {suggestions.map((suggestion) => (
        <article key={suggestion.id} className="suggestion-card" data-tone={suggestion.tone} data-state={suggestion.state}>
          <h3>
            <span className="suggestion-dot" aria-hidden="true" />
            {suggestion.title}
          </h3>
          <p>{suggestion.description}</p>
          <footer>
            <span className="suggestion-metric">{suggestion.metric}</span>
            {suggestion.state === 'done' ? (
              <span className="suggestion-done">Aplicado ✓</span>
            ) : suggestion.state === 'busy' ? (
              <span className="assistant-spinner" aria-hidden="true" />
            ) : (
              <button className="suggestion-apply" onClick={suggestion.action}>
                {suggestion.state === 'setup' ? 'Configurar IA' : 'Aplicar'}
              </button>
            )}
          </footer>
        </article>
      ))}
    </div>
  )
}
