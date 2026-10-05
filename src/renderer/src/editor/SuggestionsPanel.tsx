import { useEffect, useSyncExternalStore } from 'react'
import { formatTimecode } from '@shared/format'
import { AI_EFFORT_LABELS } from '@shared/models/ai'
import type { CutSuggestion, CutSuggestionKind } from '@shared/models/suggestions'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { CheckIcon, CloseIcon, GearIcon, SparklesIcon } from './icons'
import { Section } from './panelControls'

interface Props {
  store: EditorStore
  player: PreviewPlayer | null
}

export const SUGGESTION_KIND_LABELS: Record<CutSuggestionKind, string> = {
  retake: 'Repetição',
  filler: 'Vício de fala',
  'off-topic': 'Fora do assunto'
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

/** Marks a suggestion's stretch on the timeline and moves the playhead to it, so it can be heard. */
export function previewSuggestion(store: EditorStore, player: PreviewPlayer | null, suggestion: CutSuggestion): void {
  store.select(null)
  store.setSelection({ startMs: suggestion.startMs, endMs: suggestion.endMs })
  player?.seek(suggestion.startMs)
}

/**
 * Clean-up cuts proposed by an AI that reads the transcript. Every proposal
 * says what would go and why; nothing is cut until the user accepts it.
 */
export function SuggestionsPanel({ store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { suggestions, suggesting, suggestionNotice, transcript } = state
  // Which tool, model and effort to ask is the user's choice, made in the settings screen.
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const model = current?.provider.models.find((candidate) => candidate.id === current.choice.model)
  const hasSpeech = transcript !== null && transcript.words.length > 0

  useEffect(() => {
    void aiSettings.load()
  }, [])

  const ask = (): void => {
    if (!current) return
    void store.suggestCuts(current.choice, (sessionId, choice) => window.screenrx.ai.suggestCuts(sessionId, choice))
  }

  return (
    <Section title="Limpeza com IA">
      {!hasSpeech ? (
        <p className="panel-hint">
          A IA lê a transcrição da fala e propõe o que cortar: frases recomeçadas, vícios de fala e trechos
          fora do assunto. Gere as legendas primeiro, na aba Legendas — elas podem ficar ocultas.
        </p>
      ) : ai.providers === null ? (
        <p className="panel-hint">Procurando as ferramentas de IA…</p>
      ) : !current ? (
        <>
          <p className="panel-hint">
            Nenhuma ferramenta de IA está pronta neste Mac. Nas configurações você instala e entra no Claude,
            no ChatGPT ou no Antigravity.
          </p>
          <button className="panel-button" onClick={openSettings}>
            <GearIcon /> Configurar IA
          </button>
        </>
      ) : (
        <>
          {suggestions.length === 0 && (
            <p className="panel-hint">
              A IA lê a transcrição e propõe cortes: frases recomeçadas, vícios de fala e trechos fora do
              assunto. Você decide, um por um.
            </p>
          )}
          <button
            className="ai-choice"
            title="Trocar a ferramenta, o modelo ou o esforço"
            disabled={suggesting}
            onClick={openSettings}
          >
            <span className="ai-choice-text">
              <strong>{current.provider.label}</strong>
              <span>
                {model?.label ?? current.choice.model} · esforço {AI_EFFORT_LABELS[current.choice.effort].toLowerCase()}
              </span>
            </span>
            <GearIcon />
          </button>
          {suggesting ? (
            <div className="progress" role="status">
              <span className="progress-label">Analisando a transcrição…</span>
              <span className="progress-track">
                <span className="progress-fill" data-indeterminate="true" style={{ width: '100%' }} />
              </span>
              <button className="panel-button" onClick={() => void window.screenrx.ai.cancel()}>
                Cancelar
              </button>
            </div>
          ) : (
            <button className="panel-button panel-button-ai" onClick={ask}>
              <SparklesIcon /> {suggestions.length > 0 ? 'Analisar de novo' : 'Sugerir cortes'}
            </button>
          )}
          {suggestionNotice && <p className="panel-notice">{suggestionNotice}</p>}

          {suggestions.length > 0 && (
            <>
              <ul className="suggestion-list">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.id} className="suggestion" data-kind={suggestion.kind}>
                    <button
                      className="suggestion-main"
                      title="Ver este trecho na linha do tempo"
                      onClick={() => previewSuggestion(store, player, suggestion)}
                    >
                      <span className="suggestion-head">
                        <span className="suggestion-kind">{SUGGESTION_KIND_LABELS[suggestion.kind]}</span>
                        <span className="suggestion-time">
                          {formatTimecode(suggestion.startMs)} · {seconds(suggestion.endMs - suggestion.startMs)}
                        </span>
                      </span>
                      <span className="suggestion-text">“{suggestion.text}”</span>
                      {suggestion.reason && <span className="suggestion-reason">{suggestion.reason}</span>}
                    </button>
                    <span className="suggestion-actions">
                      <button
                        className="suggestion-accept"
                        aria-label={`Cortar: ${suggestion.text}`}
                        onClick={() => store.acceptSuggestion(suggestion.id)}
                      >
                        <CheckIcon /> Cortar
                      </button>
                      <button
                        className="suggestion-reject"
                        aria-label={`Manter: ${suggestion.text}`}
                        onClick={() => store.rejectSuggestion(suggestion.id)}
                      >
                        <CloseIcon /> Manter
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="suggestion-all">
                <button className="panel-button" onClick={() => store.acceptAllSuggestions()}>
                  Cortar todas ({suggestions.length})
                </button>
                <button className="panel-button" onClick={() => store.clearSuggestions()}>
                  Dispensar
                </button>
              </div>
            </>
          )}
          <p className="panel-hint">
            Só o texto da transcrição é enviado ao {current.provider.label}, pela ferramenta instalada neste
            Mac. O áudio e o vídeo não saem daqui.
          </p>
        </>
      )}
    </Section>
  )
}
