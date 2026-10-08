import type { KeyboardEvent } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AssistantEditState, AssistantMessage } from '@shared/models/assistant'
import { ASSISTANT_LIMITS } from '@shared/models/assistant'
import type { CaptionLanguage } from '@shared/models/project'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { useDictation } from '../common/dictation'
import { openSettings } from '../common/settingsScreen'
import type { EditorStore } from './EditorStore'
import { applyAssistantActions } from './assistantActions'
import { AiChoicePicker } from './AiChoicePicker'
import { AssistantSuggestions } from './AssistantSuggestions'
import { CloseIcon, GearIcon, MicIcon, SparklesIcon } from './icons'

interface Props {
  store: EditorStore
}

/** A line of the chat: what was said, and for the assistant, what it did. */
interface ChatEntry extends AssistantMessage {
  id: number
  done?: string[]
  skipped?: string[]
}

/** The editor as it stands, in the terms the AI is told about. */
function editStateOf(store: EditorStore): AssistantEditState {
  const state = store.getState()
  const { session } = store
  return {
    durationMs: session.durationMs,
    cuts: state.trims.map(({ startMs, endMs }) => ({ startMs, endMs })),
    zooms: state.zooms.map(({ startMs, endMs, scale }) => ({ startMs, endMs, scale })),
    speed: state.exportSettings.speed,
    hasCaptions: state.captions.cues.length > 0,
    captionsVisible: state.captions.visible,
    captionLanguage: state.captions.language,
    captionLength: state.captions.length,
    backgroundId: state.background.presetId,
    hasWebcam: session.webcam !== null,
    webcamVisible: state.webcam.visible,
    hasSystemAudio: session.audio.some((track) => track.kind === 'systemAudio'),
    microphoneMuted: state.audio.microphone.muted,
    systemAudioMuted: state.audio.systemAudio.muted
  }
}

/**
 * A conversation with the AI tool in use, beside the editor. The user asks
 * in plain words; the answer comes with the edits to make, which are applied
 * at once as one undo step. Only text leaves the machine: the transcript,
 * the state of the edit and the conversation.
 */
export function AssistantPanel({ store }: Props) {
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Simple: what the assistant sees to do, as cards. Advanced: the conversation.
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple')
  const listRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(1)
  // Dictation writes into the field, so the words are read before they are sent.
  const dictation = useDictation((text) => setDraft((current) => (current.trim() === '' ? text : `${current.trimEnd()} ${text}`)))
  const dictationTime = `${Math.floor(dictation.seconds / 60)}:${String(dictation.seconds % 60).padStart(2, '0')}`

  useEffect(() => {
    void aiSettings.load()
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [entries, asking])

  // Leaving the editor abandons an answer still on its way.
  useEffect(() => {
    return () => {
      if (asking) void window.screenrx.ai.cancel()
    }
  }, [asking])

  const translate = (language: CaptionLanguage): void => {
    if (!current) return
    const { choice } = current
    void store.translateCaptions(language, (target, cues, sourceLocale) =>
      window.screenrx.captions.translate({ language: target, cues, sourceLocale }, choice)
    )
  }

  const send = async (): Promise<void> => {
    const message = draft.trim()
    if (!current || asking || message === '') return
    const history = entries.map(({ role, text }) => ({ role, text }))
    setEntries((previous) => [...previous, { id: nextId.current++, role: 'user', text: message }])
    setDraft('')
    setFailure(null)
    setMode('advanced')
    setAsking(true)
    const result = await window.screenrx.ai
      .assist(store.session.sessionId, { message, history, edit: editStateOf(store) }, current.choice)
      .catch(() => null)
    setAsking(false)
    if (!result?.ok) {
      if (result?.error.code !== 'ai-cancelled') setFailure(result?.error.message ?? 'A IA não respondeu.')
      return
    }
    const applied = applyAssistantActions(store, result.value.actions, translate)
    const text = result.value.text || (applied.done.length > 0 ? 'Feito.' : 'Não consegui fazer isso.')
    setEntries((previous) => [
      ...previous,
      { id: nextId.current++, role: 'assistant', text, done: applied.done, skipped: applied.skipped }
    ])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <aside className="assistant" aria-label="Assistente">
      <header className="assistant-head">
        <span className="assistant-title">
          <SparklesIcon /> Assistente
        </span>
      </header>

      {mode === 'simple' ? (
        <div className="assistant-messages">
          <AssistantSuggestions store={store} />
        </div>
      ) : (
      <div className="assistant-messages" ref={listRef}>
        {ai.providers !== null && !current ? (
          <div className="assistant-empty">
            <p className="panel-hint">Nenhuma ferramenta de IA está pronta.</p>
            <button className="panel-button" onClick={openSettings}>
              <GearIcon /> Configurar IA
            </button>
          </div>
        ) : entries.length === 0 && !asking ? (
          <div className="assistant-empty">
            <p className="panel-hint">
              Peça edições ou pergunte sobre a gravação. Por exemplo: “corta a parte em que eu falo do frete”,
              “coloca zoom quando eu abro o pedido”, “deixa em 1,5×”.
            </p>
            <p className="panel-hint">A IA só conhece o que foi dito; ela não vê o vídeo. Tudo pode ser desfeito com ⌘Z.</p>
          </div>
        ) : null}

        {entries.map((entry) => (
          <div key={entry.id} className="assistant-message" data-role={entry.role}>
            <p>{entry.text}</p>
            {entry.done && entry.done.length > 0 && (
              <ul className="assistant-actions">
                {entry.done.map((label, index) => (
                  <li key={index} data-done="true">
                    {label}
                  </li>
                ))}
              </ul>
            )}
            {entry.skipped && entry.skipped.length > 0 && (
              <ul className="assistant-actions">
                {entry.skipped.map((label, index) => (
                  <li key={index} data-done="false" title="Não foi possível aplicar">
                    {label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {asking && (
          <div className="assistant-message" data-role="assistant">
            <span className="assistant-thinking">
              <span className="assistant-spinner" aria-hidden="true" /> Pensando…
            </span>
            <button className="panel-button" onClick={() => void window.screenrx.ai.cancel()}>
              Cancelar
            </button>
          </div>
        )}
        {failure && (
          <p className="panel-notice" role="alert">
            {failure}
          </p>
        )}
        {dictation.error && (
          <p className="panel-notice" role="alert">
            {dictation.error}
          </p>
        )}
      </div>
      )}

      <form
        className="assistant-compose"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          className="assistant-input"
          rows={2}
          placeholder={current ? 'Peça uma edição…' : 'Configure uma ferramenta de IA para conversar.'}
          maxLength={ASSISTANT_LIMITS.maxMessageLength}
          value={draft}
          disabled={!current || asking}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="assistant-compose-row">
          <div className="assistant-mode" role="radiogroup" aria-label="Modo">
            <button type="button" role="radio" aria-checked={mode === 'simple'} onClick={() => setMode('simple')}>
              Simples
            </button>
            <button type="button" role="radio" aria-checked={mode === 'advanced'} onClick={() => setMode('advanced')}>
              Avançado
            </button>
          </div>
          <AiChoicePicker disabled={asking} />
          <div className="assistant-dictate" data-phase={dictation.phase}>
            {dictation.phase === 'recording' && (
              <>
                <button className="assistant-dictate-cancel" type="button" aria-label="Descartar a gravação" title="Descartar a gravação" onClick={dictation.cancel}>
                  <CloseIcon />
                </button>
                <span className="assistant-dictate-time">{dictationTime}</span>
              </>
            )}
            {dictation.phase === 'transcribing' && <span className="assistant-dictate-time">Transcrevendo…</span>}
            <button
              className="assistant-mic"
              type="button"
              disabled={!current || asking || dictation.phase === 'transcribing'}
              aria-label={dictation.phase === 'recording' ? 'Terminar e transcrever' : 'Ditar'}
              title={
                dictation.phase === 'recording'
                  ? 'Terminar e transcrever'
                  : dictation.phase === 'transcribing'
                    ? 'Transcrevendo o áudio…'
                    : 'Ditar: grava o microfone e escreve o texto no campo'
              }
              onClick={dictation.toggle}
            >
              {dictation.phase === 'transcribing' ? (
                <span className="assistant-spinner" aria-hidden="true" />
              ) : dictation.phase === 'recording' ? (
                <span className="assistant-stop" aria-hidden="true" />
              ) : (
                <MicIcon />
              )}
            </button>
          </div>
          <button
            className="assistant-send"
            type="submit"
            aria-label="Enviar"
            title="Enviar (Enter)"
            disabled={!current || asking || draft.trim() === ''}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
      </form>
    </aside>
  )
}
