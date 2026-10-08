import { useEffect, useSyncExternalStore } from 'react'
import { formatTimecode } from '@shared/format'
import type { CutSuggestion, CutSuggestionKind } from '@shared/models/suggestions'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { CheckIcon, CloseIcon, GearIcon, LockIcon, SparklesIcon } from './icons'
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
  const hasSpeech = transcript !== null && transcript.words.length > 0

  useEffect(() => {
    void aiSettings.load()
  }, [])

  const ask = (): void => {
    if (!current) return
    void store.suggestCuts(current.choice, (sessionId, choice) => window.screenrx.ai.suggestCuts(sessionId, choice))
  }

  const aside = current ? (
    <span className="suggestions-source">
      <LockIcon /> {current.provider.label} · só texto
      <button className="field-link" aria-label="Trocar a ferramenta de IA" title="Trocar a ferramenta, o modelo ou o esforço" onClick={openSettings}>
        <GearIcon />
      </button>
    </span>
  ) : undefined

  return (
    <Section title="Sugestões da IA" aside={aside}>
      {!hasSpeech ? (
        <p className="panel-hint">Gere as legendas primeiro, na aba Legendas.</p>
      ) : ai.providers === null ? (
        <p className="panel-hint">Procurando as ferramentas de IA…</p>
      ) : !current ? (
        <>
          <p className="panel-hint">Nenhuma ferramenta de IA está pronta.</p>
          <button className="panel-button" onClick={openSettings}>
            <GearIcon /> Configurar IA
          </button>
        </>
      ) : (
        <>
          {suggestions.length > 0 && (
            <ul className="suggestion-list">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id} className="suggestion" data-kind={suggestion.kind}>
                  <button className="suggestion-main" title="Ver este trecho na linha do tempo" onClick={() => previewSuggestion(store, player, suggestion)}>
                    <span className="suggestion-head">
                      <span className="suggestion-kind">{SUGGESTION_KIND_LABELS[suggestion.kind]}</span>
                      <span className="suggestion-time">{formatTimecode(suggestion.startMs)}</span>
                      <span className="suggestion-length">{seconds(suggestion.endMs - suggestion.startMs)}</span>
                    </span>
                    <span className="suggestion-text">“{suggestion.text}”</span>
                  </button>
                  <span className="suggestion-actions">
                    <button className="suggestion-reject" aria-label={`Manter: ${suggestion.text}`} title="Manter" onClick={() => store.rejectSuggestion(suggestion.id)}>
                      <CloseIcon />
                    </button>
                    <button className="suggestion-accept" aria-label={`Cortar: ${suggestion.text}`} title="Cortar" onClick={() => store.acceptSuggestion(suggestion.id)}>
                      <CheckIcon />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {suggestions.length > 0 && (
            <div className="suggestion-all">
              <span className="panel-hint">
                {suggestions.length} para revisar
              </span>
              <button className="field-link" onClick={() => store.acceptAllSuggestions()}>
                Aceitar todas
              </button>
            </div>
          )}
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
            <button className="panel-button" onClick={ask}>
              <SparklesIcon /> {suggestions.length > 0 ? 'Analisar de novo' : 'Sugerir cortes'}
            </button>
          )}
          {suggestions.length === 0 && !suggesting && (
            <p className="panel-hint">Repetições, vícios de fala e trechos fora do assunto, a partir da fala. Você decide um por um.</p>
          )}
          {suggestionNotice && <p className="panel-notice">{suggestionNotice}</p>}
        </>
      )}
    </Section>
  )
}
