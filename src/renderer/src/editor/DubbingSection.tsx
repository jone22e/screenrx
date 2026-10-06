import { useEffect, useSyncExternalStore } from 'react'
import { CAPTION_LANGUAGE_NAMES, translationTargets } from '@engine/captions/captionTranslation'
import { formatBytes } from '@shared/format'
import { CAPTION_LOCALES } from '@shared/models/captions'
import type { DubStage } from '@shared/models/dub'
import type { CaptionLanguage } from '@shared/models/project'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import { voiceModel } from '../common/voiceModel'
import type { EditorStore } from './EditorStore'
import { GearIcon, RefreshIcon, VoiceIcon } from './icons'
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
  const { dubbing, dubNotice, translating, transcript, captions } = state
  const targets = translationTargets(transcript?.locale ?? null)
  const spoken = CAPTION_LOCALES.find((option) => option.id === transcript?.locale)?.label ?? null
  const busy = dubbing !== null || translating !== null

  useEffect(() => {
    void voiceModel.refresh()
    void aiSettings.load()
  }, [])

  const dub = (language: CaptionLanguage): void => {
    void store.dubInto(
      language,
      aiChoice
        ? (target, cues, sourceLocale) =>
            window.screenrx.captions.translate({ language: target, cues, sourceLocale }, aiChoice.choice)
        : null,
      (sessionId, request) => window.screenrx.dub.generate(sessionId, request)
    )
  }

  const intro = (
    <p className="panel-hint">
      O vídeo falado em outro idioma, com a sua própria voz. É separado das legendas: elas continuam como
      estiverem, visíveis ou não, no idioma que você escolher lá.
    </p>
  )

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
  if (captions.cues.length === 0) {
    return (
      <Section title="Dublagem">
        {intro}
        <p className="panel-hint">
          A dublagem parte do que você falou. Gere as legendas primeiro, na aba Legendas; depois elas podem
          ficar ocultas, se você não quiser legenda no vídeo.
        </p>
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
              Para clonar a sua voz o app precisa baixar um modelo de voz, uma única vez (
              {formatBytes(status.modelDownloadBytes)}). Ele roda aqui no Mac; a sua voz não é enviada para
              lugar nenhum.
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
  const counted = dubbing !== null && (dubbing.stage === 'synthesizing' || dubbing.stage === 'verifying')

  const progress = (
    <div className="progress" role="status">
      <span className="progress-label">
        {dubbing ? STAGE_LABELS[dubbing.stage] : 'Traduzindo o texto…'}
        {counted && dubbing && <strong>{percent(dubbing.fraction)}</strong>}
      </span>
      <span className="progress-track">
        <span
          className="progress-fill"
          data-indeterminate={!counted}
          style={{ width: percent(counted && dubbing ? dubbing.fraction : 1) }}
        />
      </span>
      <button
        className="panel-button"
        onClick={() => void (dubbing ? window.screenrx.dub.cancel() : window.screenrx.ai.cancel())}
      >
        Cancelar
      </button>
    </div>
  )

  return (
    <>
      <Section title="Dublagem">
        {intro}
        <label className="check">
          <input
            type="radio"
            name="dub-voice"
            checked={state.dub.language === null}
            disabled={busy}
            onChange={() => store.setDubLanguage(null)}
          />
          <span>Voz original da gravação</span>
        </label>

        {spoken && (
          <div className="dub-spoken">
            <p className="panel-hint">
              Idioma falado na gravação, segundo a transcrição: <strong>{spoken}</strong>. Por isso ele não
              aparece na lista abaixo. Se não foi esse o idioma que você falou, refaça a transcrição antes de
              dublar: o texto errado deixaria a dublagem errada.
            </p>
            <button className="panel-button" disabled={busy} onClick={onOpenCaptions}>
              Corrigir o idioma falado
            </button>
          </div>
        )}

        <ul className="dub-list">
          {targets.map((language) => {
            const name = CAPTION_LANGUAGE_NAMES[language].label
            const lower = name.toLowerCase()
            const exists = state.dubs.some((track) => track.language === language)
            const inUse = state.dub.language === language
            return (
              <li key={language} className="dub-row" data-in-use={inUse} data-language={language}>
                <div className="dub-row-head">
                  <strong>{name}</strong>
                  <span>
                    {working === language ? 'gerando…' : exists ? (inUse ? 'em uso' : 'pronta') : 'ainda não gerada'}
                  </span>
                </div>
                {working === language ? (
                  progress
                ) : exists ? (
                  <div className="dub-row-actions">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={inUse}
                        disabled={busy}
                        onChange={(event) => store.setDubLanguage(event.target.checked ? language : null)}
                      />
                      <span>Usar a dublagem em {lower} no vídeo</span>
                    </label>
                    <button
                      className="dub-again"
                      disabled={busy}
                      aria-label={`Gerar de novo a dublagem em ${lower}`}
                      title="Gerar de novo"
                      onClick={() => dub(language)}
                    >
                      <RefreshIcon />
                    </button>
                  </div>
                ) : (
                  <button className="panel-button" disabled={busy} onClick={() => dub(language)}>
                    <VoiceIcon /> Dublar em {lower}
                  </button>
                )}
              </li>
            )
          })}
        </ul>

        {dubNotice && <p className="panel-notice">{dubNotice}</p>}
        {!aiChoice && (
          <button className="panel-button" onClick={openSettings}>
            <GearIcon /> Configurar IA
          </button>
        )}
      </Section>

      <Section title="Como funciona">
        <p className="panel-hint">
          O texto falado é traduzido{aiChoice ? ` pelo ${aiChoice.provider.label}` : ' por uma ferramenta de IA'} e
          depois dito com a sua voz, aprendida dos primeiros segundos do microfone. A voz é gerada neste Mac.
        </p>
        <p className="panel-hint">
          Com uma dublagem em uso, ela toca no lugar do microfone no preview e no vídeo exportado; o som do
          sistema continua. A gravação original não é alterada.
        </p>
      </Section>
    </>
  )
}
