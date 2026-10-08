import { useEffect, useState, useSyncExternalStore } from 'react'
import { CAPTION_LANGUAGE_NAMES, translationTargets } from '@engine/captions/captionTranslation'
import { formatBytes, formatClock } from '@shared/format'
import { CAPTION_LOCALES, DEFAULT_CAPTION_LOCALE } from '@shared/models/captions'
import type { DubStage } from '@shared/models/dub'
import type { CaptionLanguage } from '@shared/models/project'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import { voiceModel } from '../common/voiceModel'
import type { EditorStore } from './EditorStore'
import { CaptionsIcon, GearIcon, PlusIcon, RefreshIcon, VoiceIcon } from './icons'
import { Section } from './panelControls'

interface Props {
  store: EditorStore
  /** Takes the user to the captions tab, where the transcription is redone. */
  onOpenCaptions: () => void
}

const STAGE_LABELS: Record<DubStage, string> = {
  downloading: 'Baixando o modelo de voz',
  unpacking: 'Preparando o modelo de voz',
  loading: 'Carregando o modelo de voz…',
  synthesizing: 'Gerando a voz',
  verifying: 'Conferindo o que foi dito',
  assembling: 'Montando a trilha…'
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/**
 * Dubbing: the recording spoken in another language, in the speaker's own
 * voice. It is its own thing, apart from captions — captions can be shown,
 * hidden or in any language whatever the voice is — though it starts from
 * the same text: what was said, translated.
 *
 * The voice is cloned on this Mac from the microphone track. The first time,
 * a voice model has to be downloaded, and only when the user asks for it.
 */
export function DubbingPanel({ store, onOpenCaptions }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const model = useSyncExternalStore(voiceModel.subscribe, voiceModel.getState)
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const aiChoice = currentAiChoice(ai)
  const { dubbing, dubNotice, translating, transcript, captions, transcription, captionNotice } = state
  const targets = translationTargets(transcript?.locale ?? null)
  const spoken = CAPTION_LOCALES.find((option) => option.id === transcript?.locale)?.label ?? null
  const [detecting, setDetecting] = useState(false)
  // Whether "+ Adicionar idioma" is open.
  const [adding, setAdding] = useState(false)
  const busy = dubbing !== null || translating !== null || transcription !== null || detecting
  const hasCaptions = captions.cues.length > 0

  useEffect(() => {
    void voiceModel.refresh()
    void aiSettings.load()
  }, [])

  /**
   * Dubs into `language`. A recording not yet transcribed is transcribed
   * first: the language spoken is judged from its first seconds (among the
   * languages whose models are on this Mac; the default otherwise), then the
   * whole track is transcribed in it, as the Legendas tab would do. The
   * dubbing starts from what was said.
   */
  const dub = async (language: CaptionLanguage): Promise<void> => {
    if (store.getState().captions.cues.length === 0) {
      const track = store.session.audio.some((candidate) => candidate.kind === 'microphone') ? 'microphone' : 'systemAudio'
      setDetecting(true)
      const detected = await window.screenrx.captions.detectLocale(store.session.sessionId, track).catch(() => null)
      setDetecting(false)
      const locale = detected?.ok && detected.value.locale ? detected.value.locale : DEFAULT_CAPTION_LOCALE
      await store.generateCaptions({ locale, track }, (sessionId, request) =>
        window.screenrx.captions.generate(sessionId, request)
      )
      if (store.getState().captions.cues.length === 0) return
    }
    await store.dubInto(
      language,
      aiChoice
        ? (target, cues, sourceLocale) =>
            window.screenrx.captions.translate({ language: target, cues, sourceLocale }, aiChoice.choice)
        : null,
      (sessionId, request) => window.screenrx.dub.generate(sessionId, request)
    )
  }

  const introText = 'O vídeo falado em outro idioma, com a sua própria voz.'
  const intro = <p className="panel-hint">{introText}</p>

  const status = model.status
  if (status === null) {
    return <Section title="Dublagem">{intro}</Section>
  }
  if (!status.available) {
    return (
      <Section title="Dublagem">
        {intro}
        <p className="panel-notice">A dublagem não está disponível nesta versão do app.</p>
      </Section>
    )
  }
  if (store.session.audio.length === 0) {
    return (
      <Section title="Dublagem">
        {intro}
        <p className="panel-hint">Esta gravação não tem áudio para dublar.</p>
      </Section>
    )
  }

  if (model.progress || status.model !== 'ready') {
    return (
      <Section title="Dublagem">
        {intro}
        {model.progress ? (
          <div className="progress" role="status">
            <span className="progress-label">
              {STAGE_LABELS[model.progress.stage]} <strong>{percent(model.progress.fraction)}</strong>
            </span>
            <span className="progress-track">
              <span className="progress-fill" style={{ width: percent(model.progress.fraction) }} />
            </span>
            <button className="panel-button" onClick={() => voiceModel.cancel()}>
              Cancelar
            </button>
          </div>
        ) : (
          <>
            <p className="panel-hint">
              Para clonar a sua voz, baixe o modelo de voz uma única vez ({formatBytes(status.modelDownloadBytes)}).
              Tudo roda neste Mac.
            </p>
            <button className="panel-button panel-button-primary" onClick={() => void voiceModel.download()}>
              Baixar modelo de voz · {formatBytes(status.modelDownloadBytes)}
            </button>
            {model.failure && <p className="panel-notice">{model.failure}</p>}
          </>
        )}
      </Section>
    )
  }

  const working = dubbing?.language ?? translating

  const generated = targets.filter((language) => state.dubs.some((track) => track.language === language))
  const missing = targets.filter((language) => !generated.includes(language) && working !== language)
  const inUse = state.dub.language
  const captionsBehind =
    inUse !== null && captions.visible && hasCaptions && captions.language !== inUse
  const captionsLanguageLabel = captions.language ? CAPTION_LANGUAGE_NAMES[captions.language].label : (spoken ?? 'original')
  const useDubLanguageForCaptions = (): void => {
    if (inUse === null) return
    if (!store.setCaptionLanguage(inUse) && aiChoice) {
      void store.translateCaptions(inUse, (target, cues, sourceLocale) =>
        window.screenrx.captions.translate({ language: target, cues, sourceLocale }, aiChoice.choice)
      )
    }
  }

  /** The three steps of a dubbing being made, for the card of the language in progress. */
  const steps = (language: CaptionLanguage) => {
    const transcribing = detecting || transcription !== null
    const translated = captions.translations[language] !== undefined
    return [
      { label: 'Transcrever', state: hasCaptions ? 'done' : transcribing ? 'active' : 'todo' },
      { label: 'Traduzir', state: translated ? 'done' : translating === language ? 'active' : 'todo' },
      { label: 'Gerar voz', state: dubbing?.language === language ? 'active' : 'todo' }
    ] as const
  }
  const cancelWork = (): void => {
    if (dubbing) void window.screenrx.dub.cancel()
    else if (translating) void window.screenrx.ai.cancel()
    else void window.screenrx.captions.cancel()
  }

  return (
    <>
      <Section title="Dublagem">
        <div className="dub-head">
          <span className="panel-hint">{introText}</span>
          <span className="dub-in-use">Em uso: {inUse ? CAPTION_LANGUAGE_NAMES[inUse].label : 'Original'}</span>
        </div>

        <div className="dub-spoken-row">
          <VoiceIcon />
          <span>
            Falado em <strong>{spoken ?? 'idioma a descobrir'}</strong>
          </span>
          <button className="field-link" disabled={busy} onClick={onOpenCaptions}>
            Alterar
          </button>
        </div>
        {!hasCaptions && !transcription && !detecting && (
          <p className="panel-hint">
            A primeira dublagem descobre o idioma falado e transcreve nele. Só os idiomas já baixados no Mac são
            reconhecidos; os outros, pela aba Legendas.
          </p>
        )}
        {captionNotice && !transcription && <p className="panel-notice">{captionNotice}</p>}

        <ul className="dub-cards" role="radiogroup" aria-label="Voz do vídeo">
          <li className="dub-card" data-in-use={inUse === null}>
            <label className="dub-card-main">
              <input type="radio" name="dub-voice" checked={inUse === null} disabled={busy} onChange={() => store.setDubLanguage(null)} />
              <span className="dub-card-text">
                <strong>Original</strong>
                <span>{spoken ?? 'Idioma falado'} · sua voz gravada</span>
              </span>
            </label>
          </li>

          {generated.map((language) => {
            const name = CAPTION_LANGUAGE_NAMES[language].label
            const selected = inUse === language
            return (
              <li key={language} className="dub-card" data-in-use={selected}>
                <label className="dub-card-main">
                  <input type="radio" name="dub-voice" checked={selected} disabled={busy} onChange={() => store.setDubLanguage(language)} />
                  <span className="dub-card-text">
                    <strong>{name}</strong>
                    <span>Gerada · {formatClock(store.session.durationMs)}</span>
                  </span>
                </label>
                <button
                  className="dub-again"
                  disabled={busy}
                  aria-label={`Gerar de novo a dublagem em ${name.toLowerCase()}`}
                  title="Gerar de novo"
                  onClick={() => void dub(language)}
                >
                  <RefreshIcon />
                </button>
              </li>
            )
          })}

          {working && (
            <li className="dub-card dub-card-working">
              <div className="dub-card-main">
                <span className="dub-card-radio" aria-hidden="true" />
                <span className="dub-card-text">
                  <strong>{CAPTION_LANGUAGE_NAMES[working].label}</strong>
                  <span>
                    Gerando
                    {dubbing && (dubbing.stage === 'synthesizing' || dubbing.stage === 'verifying') && ` · ${percent(dubbing.fraction)}`}
                    {dubbing && dubbing.stage !== 'synthesizing' && dubbing.stage !== 'verifying' && ` · ${STAGE_LABELS[dubbing.stage].toLowerCase()}`}
                    {!dubbing && (transcription || detecting) && (transcription?.stage === 'transcribing' ? ` · transcrevendo ${percent(transcription.fraction)}` : ' · ouvindo a fala')}
                    {!dubbing && !transcription && !detecting && translating && ' · traduzindo'}
                  </span>
                </span>
                <button className="field-link" onClick={cancelWork}>
                  Cancelar
                </button>
              </div>
              <ol className="dub-steps">
                {steps(working).map((step) => (
                  <li key={step.label} data-state={step.state}>
                    <span className="dub-step-bar" aria-hidden="true" />
                    <span className="dub-step-label">
                      {step.state === 'done' && '✓ '}
                      {step.label}
                    </span>
                  </li>
                ))}
              </ol>
            </li>
          )}
        </ul>

        {missing.length > 0 && (
          <div className="dub-add">
            <button className="dub-add-button" disabled={busy} aria-expanded={adding} onClick={() => setAdding((value) => !value)}>
              <PlusIcon /> Adicionar idioma
            </button>
            {adding && (
              <div className="dub-add-menu" role="menu">
                {missing.map((language) => (
                  <button
                    key={language}
                    role="menuitem"
                    onClick={() => {
                      setAdding(false)
                      void dub(language)
                    }}
                  >
                    <VoiceIcon /> {CAPTION_LANGUAGE_NAMES[language].label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {captionsBehind && inUse && (
          <div className="dub-captions-notice">
            <CaptionsIcon />
            <span>As legendas ainda estão em {captionsLanguageLabel.toLowerCase()}.</span>
            <button className="field-link" disabled={busy} onClick={useDubLanguageForCaptions}>
              Usar {CAPTION_LANGUAGE_NAMES[inUse].label.toLowerCase()}
            </button>
          </div>
        )}

        {dubNotice && <p className="panel-notice">{dubNotice}</p>}
        {!aiChoice && (
          <button className="panel-button" onClick={openSettings}>
            <GearIcon /> Configurar IA
          </button>
        )}
      </Section>

      <Section title="Como funciona">
        <p className="panel-hint">
          O texto é traduzido{aiChoice ? ` pelo ${aiChoice.provider.label}` : ' por uma ferramenta de IA'} e dito com
          a sua voz, gerada neste Mac. A dublagem em uso toca no lugar do microfone, no preview e na exportação. A
          gravação original não muda.
        </p>
      </Section>
    </>
  )
}
