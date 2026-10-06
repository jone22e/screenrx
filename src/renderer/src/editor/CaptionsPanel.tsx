import type { CSSProperties } from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { CAPTION_FONTS, CAPTION_POSITIONS } from '@engine/captions/captionConfig'
import { cueAt } from '@engine/captions/captionCues'
import { CAPTION_LANGUAGE_NAMES, translationTargets } from '@engine/captions/captionTranslation'
import { formatTimecode } from '@shared/format'
import type { CaptionLocaleId, TranscriptTrack } from '@shared/models/captions'
import { CAPTION_LOCALES, DEFAULT_CAPTION_LOCALE, isCaptionLocale } from '@shared/models/captions'
import type { EditorSession } from '@shared/models/editor'
import type {
  CaptionBackdrop,
  CaptionFont,
  CaptionLanguage,
  CaptionLength,
  CaptionStyle
} from '@shared/models/project'
import { CAPTION_FONT_IDS, CAPTION_LIMITS } from '@shared/models/project'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import type { EditorStore, TranscriptionActivity } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { CaptionsIcon, GearIcon, RefreshIcon, TrashIcon } from './icons'
import { Section, Segmented, Slider } from './panelControls'

interface Props {
  session: EditorSession
  store: EditorStore
  player: PreviewPlayer | null
}

const TRACK_LABELS: Record<TranscriptTrack, string> = {
  microphone: 'Microfone',
  systemAudio: 'Som do sistema'
}

const LENGTHS: ReadonlyArray<{ value: CaptionLength; label: string }> = [
  { value: 'short', label: 'Curtas' },
  { value: 'medium', label: 'Médias' },
  { value: 'long', label: 'Longas' }
]

const BACKDROPS: ReadonlyArray<{ value: CaptionBackdrop; label: string }> = [
  { value: 'box', label: 'Caixa' },
  { value: 'outline', label: 'Contorno' },
  { value: 'shadow', label: 'Sombra' },
  { value: 'none', label: 'Nada' }
]

type Placement = keyof typeof CAPTION_POSITIONS

const PLACEMENTS: ReadonlyArray<{ value: Placement; label: string }> = [
  { value: 'top', label: 'Topo' },
  { value: 'middle', label: 'Meio' },
  { value: 'bottom', label: 'Base' }
]

type Look = Pick<CaptionStyle, 'font' | 'bold' | 'uppercase' | 'color' | 'backdrop' | 'backdropColor'>

/** Ready-made looks: one click sets font, colours and backdrop together. */
const LOOKS: ReadonlyArray<{ id: string; label: string; look: Look }> = [
  {
    id: 'classic',
    label: 'Clássica',
    look: { font: 'system', bold: true, uppercase: false, color: '#ffffff', backdrop: 'box', backdropColor: '#000000' }
  },
  {
    id: 'outline',
    label: 'Contorno',
    look: { font: 'system', bold: true, uppercase: false, color: '#ffffff', backdrop: 'outline', backdropColor: '#000000' }
  },
  {
    id: 'highlight',
    label: 'Destaque',
    look: { font: 'impact', bold: true, uppercase: true, color: '#ffe14d', backdrop: 'outline', backdropColor: '#000000' }
  },
  {
    id: 'clean',
    label: 'Suave',
    look: { font: 'rounded', bold: false, uppercase: false, color: '#ffffff', backdrop: 'shadow', backdropColor: '#000000' }
  }
]

const LOOK_KEYS = ['font', 'bold', 'uppercase', 'color', 'backdrop', 'backdropColor'] as const
const hasLook = (style: CaptionStyle, look: Look): boolean => LOOK_KEYS.every((key) => style[key] === look[key])

/** How a look is previewed on its button, approximating what the canvas draws. */
function lookSample(look: Look): CSSProperties {
  return {
    fontFamily: CAPTION_FONTS[look.font].family,
    fontWeight: look.bold ? 700 : 500,
    color: look.color,
    textTransform: look.uppercase ? 'uppercase' : 'none',
    ...(look.backdrop === 'box' && { background: `${look.backdropColor}c7`, padding: '1px 7px', borderRadius: 5 }),
    ...(look.backdrop === 'outline' && { WebkitTextStroke: `3px ${look.backdropColor}`, paintOrder: 'stroke fill' }),
    ...(look.backdrop === 'shadow' && { textShadow: '0 1px 4px rgba(0, 0, 0, 0.9)' })
  }
}

const STAGE_LABELS: Record<TranscriptionActivity['stage'], string> = {
  preparing: 'Preparando…',
  downloading: 'Baixando o modelo do idioma…',
  transcribing: 'Transcrevendo'
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/** Captions: generated from the speech in the recording, then styled, placed and edited here. */
export function CaptionsPanel({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { captions, transcript, transcription, captionNotice } = state
  const tracks = session.audio.map((track) => track.kind)
  const [locale, setLocale] = useState<CaptionLocaleId>(
    transcript && isCaptionLocale(transcript.locale) ? transcript.locale : DEFAULT_CAPTION_LOCALE
  )
  const [track, setTrack] = useState<TranscriptTrack>(transcript?.track ?? tracks[0] ?? 'microphone')
  const [activeCueId, setActiveCueId] = useState<string | null>(null)
  // Translating is done by the AI tool chosen in the settings.
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const aiChoice = currentAiChoice(ai)

  useEffect(() => {
    void aiSettings.load()
  }, [])

  // The caption under the playhead is marked in the list; React only re-renders when it changes.
  useEffect(() => {
    if (!player) return
    return player.onTime((timeMs) => setActiveCueId(cueAt(store.getState().captions.cues, timeMs)?.id ?? null))
  }, [player, store])

  if (tracks.length === 0) {
    return (
      <Section title="Legendas">
        <p className="panel-hint">
          Esta gravação não tem áudio. As legendas são geradas a partir da fala: grave com o microfone ligado
          para poder usá-las.
        </p>
      </Section>
    )
  }

  const showFirstCaption = (): void => {
    const first = store.getState().captions.cues[0]
    if (first && player) player.seek(first.startMs)
  }

  const generate = async (force: boolean): Promise<void> => {
    const reusable =
      !force && transcript !== null && transcript.locale === locale && transcript.track === track && transcript.words.length > 0
    if (reusable) {
      // Already transcribed in this language: the captions are rebuilt at once.
      store.rebuildCaptions()
    } else {
      await store.generateCaptions({ locale, track }, (sessionId, request) =>
        window.screenrx.captions.generate(sessionId, request)
      )
    }
    showFirstCaption()
  }

  const source = (
    <>
      <label className="field">
        <span className="field-label">Idioma em que você falou</span>
        <select
          className="select"
          value={locale}
          disabled={transcription !== null}
          onChange={(event) => isCaptionLocale(event.target.value) && setLocale(event.target.value)}
        >
          {CAPTION_LOCALES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {tracks.length > 1 && (
        <Segmented
          label="Áudio"
          value={track}
          options={tracks.map((kind) => ({ value: kind, label: TRACK_LABELS[kind] }))}
          onChange={setTrack}
        />
      )}
    </>
  )

  const activity = transcription && (
    <div className="progress" role="status">
      <span className="progress-label">
        {STAGE_LABELS[transcription.stage]}
        {transcription.stage === 'transcribing' && <strong>{percent(transcription.fraction)}</strong>}
      </span>
      <span className="progress-track">
        <span
          className="progress-fill"
          data-indeterminate={transcription.stage !== 'transcribing'}
          style={{ width: percent(transcription.stage === 'transcribing' ? transcription.fraction : 1) }}
        />
      </span>
      <button className="panel-button" onClick={() => void window.screenrx.captions.cancel()}>
        Cancelar
      </button>
    </div>
  )

  if (captions.cues.length === 0) {
    return (
      <Section title="Legendas automáticas">
        <p className="panel-hint">
          O ScreenRx ouve a gravação e escreve o que foi dito, com o tempo de cada palavra. A fala é
          reconhecida aqui no Mac: o áudio não é enviado para lugar nenhum.
        </p>
        {source}
        {activity ?? (
          <button className="panel-button panel-button-primary" onClick={() => void generate(false)}>
            <CaptionsIcon /> Gerar legendas
          </button>
        )}
        {captionNotice && <p className="panel-notice">{captionNotice}</p>}
      </Section>
    )
  }

  const { style } = captions
  const { translating } = state
  const spokenLocale = transcript?.locale ?? null
  const spoken = CAPTION_LOCALES.find((option) => option.id === spokenLocale)?.label ?? 'idioma falado'
  const targets = translationTargets(spokenLocale)

  const translate = (language: CaptionLanguage): void => {
    if (!aiChoice) return
    void store.translateCaptions(language, (target, cues, sourceLocale) =>
      window.screenrx.captions.translate({ language: target, cues, sourceLocale }, aiChoice.choice)
    )
  }

  /** Shows the captions in a language, translating them first when that has not been done yet. */
  const chooseLanguage = (language: CaptionLanguage | null): void => {
    if (language === null || captions.translations[language]) store.setCaptionLanguage(language)
    else translate(language)
  }
  const placement = PLACEMENTS.find(
    (option) => style.position.x === 0.5 && style.position.y === CAPTION_POSITIONS[option.value]
  )

  return (
    <>
      <Section title="Legendas">
        <label className="check">
          <input
            type="checkbox"
            checked={captions.visible}
            onChange={(event) => store.setCaptionsVisible(event.target.checked)}
          />
          <span>Mostrar legendas no vídeo</span>
        </label>
        <Segmented
          label="Texto por legenda"
          value={captions.length}
          options={LENGTHS}
          onChange={(length) => store.setCaptionLength(length)}
        />
      </Section>

      <Section title="Idioma da legenda">
        <p className="panel-hint">
          Em que idioma o texto aparece no vídeo. Muda só a legenda; para mudar a voz, use a aba Dublagem.
        </p>
        <div className="languages" role="radiogroup" aria-label="Idioma da legenda">
          <button
            className="language"
            role="radio"
            aria-checked={captions.language === null}
            disabled={translating !== null}
            onClick={() => chooseLanguage(null)}
          >
            <strong>Original</strong>
            <span>{spoken}</span>
          </button>
          {targets.map((language) => {
            const translated = captions.translations[language] !== undefined
            return (
              <button
                key={language}
                className="language"
                role="radio"
                aria-checked={captions.language === language}
                disabled={translating !== null || (!translated && !aiChoice)}
                onClick={() => chooseLanguage(language)}
              >
                <strong>{CAPTION_LANGUAGE_NAMES[language].label}</strong>
                <span>
                  {translating === language ? 'traduzindo…' : translated ? 'traduzida' : 'traduzir com IA'}
                </span>
              </button>
            )
          })}
        </div>

        {translating !== null ? (
          <div className="progress" role="status">
            <span className="progress-label">
              Traduzindo para {CAPTION_LANGUAGE_NAMES[translating].label.toLowerCase()}…
            </span>
            <span className="progress-track">
              <span className="progress-fill" data-indeterminate="true" style={{ width: '100%' }} />
            </span>
            <button className="panel-button" onClick={() => void window.screenrx.ai.cancel()}>
              Cancelar
            </button>
          </div>
        ) : !aiChoice ? (
          <>
            <p className="panel-hint">
              A tradução é feita por uma ferramenta de IA, e nenhuma está pronta neste Mac.
            </p>
            <button className="panel-button" onClick={openSettings}>
              <GearIcon /> Configurar IA
            </button>
          </>
        ) : (
          <>
            {captions.language !== null && (
              <button className="panel-button" onClick={() => captions.language && translate(captions.language)}>
                <RefreshIcon /> Traduzir de novo
              </button>
            )}
            <p className="panel-hint">
              A tradução usa o {aiChoice.provider.label}; só o texto das legendas é enviado. Corrija o que quiser
              na lista abaixo. Trocar o tamanho do texto refaz as legendas e descarta as traduções.
            </p>
          </>
        )}
        {captionNotice && <p className="panel-notice">{captionNotice}</p>}
      </Section>

      <Section title="Estilo">
        <div className="looks" role="group" aria-label="Estilos prontos">
          {LOOKS.map(({ id, label, look }) => (
            <button
              key={id}
              className="look"
              aria-pressed={hasLook(style, look)}
              aria-label={`Estilo ${label}`}
              title={label}
              onClick={() => store.setCaptionStyle(look)}
            >
              <span className="look-sample">
                <span style={lookSample(look)}>Aa</span>
              </span>
              <span className="look-name">{label}</span>
            </button>
          ))}
        </div>

        <label className="field">
          <span className="field-label">Fonte</span>
          <select
            className="select"
            value={style.font}
            onChange={(event) => store.setCaptionStyle({ font: event.target.value as CaptionFont })}
          >
            {CAPTION_FONT_IDS.map((font) => (
              <option key={font} value={font}>
                {CAPTION_FONTS[font].label}
              </option>
            ))}
          </select>
        </label>

        <Slider
          label="Tamanho"
          value={percent(style.sizeRatio / CAPTION_LIMITS.maxSizeRatio)}
          min={CAPTION_LIMITS.minSizeRatio}
          max={CAPTION_LIMITS.maxSizeRatio}
          step={0.0025}
          current={style.sizeRatio}
          onChange={(sizeRatio) => store.setCaptionStyle({ sizeRatio }, 'caption-size')}
          onCommit={() => store.endGesture()}
        />

        <div className="check-row">
          <label className="check">
            <input
              type="checkbox"
              checked={style.bold}
              onChange={(event) => store.setCaptionStyle({ bold: event.target.checked })}
            />
            <span>Negrito</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={style.uppercase}
              onChange={(event) => store.setCaptionStyle({ uppercase: event.target.checked })}
            />
            <span>Maiúsculas</span>
          </label>
        </div>

        <Segmented
          label="Fundo do texto"
          value={style.backdrop}
          options={BACKDROPS}
          onChange={(backdrop) => store.setCaptionStyle({ backdrop })}
        />

        <div className="color-row">
          <label className="color-field">
            <input
              type="color"
              aria-label="Cor do texto"
              value={style.color}
              onChange={(event) => store.setCaptionStyle({ color: event.target.value }, 'caption-color')}
              onBlur={() => store.endGesture()}
            />
            <span>Texto</span>
          </label>
          {(style.backdrop === 'box' || style.backdrop === 'outline') && (
            <label className="color-field">
              <input
                type="color"
                aria-label={style.backdrop === 'box' ? 'Cor da caixa' : 'Cor do contorno'}
                value={style.backdropColor}
                onChange={(event) =>
                  store.setCaptionStyle({ backdropColor: event.target.value }, 'caption-backdrop-color')
                }
                onBlur={() => store.endGesture()}
              />
              <span>{style.backdrop === 'box' ? 'Caixa' : 'Contorno'}</span>
            </label>
          )}
        </div>
      </Section>

      <Section title="Posição">
        <Segmented
          label={placement ? 'No vídeo' : 'No vídeo · livre'}
          value={placement?.value ?? 'free'}
          options={PLACEMENTS}
          onChange={(value) =>
            value !== 'free' && store.setCaptionStyle({ position: { x: 0.5, y: CAPTION_POSITIONS[value] } })
          }
        />
        <p className="panel-hint">Ou arraste a legenda no vídeo para qualquer lugar.</p>
      </Section>

      <Section title={`Texto (${captions.cues.length})`}>
        <p className="panel-hint">Corrija o que foi entendido errado. O tempo se ajusta na linha do tempo.</p>
        <ul className="cue-list">
          {captions.cues.map((cue) => (
            <li
              key={cue.id}
              className="cue-row"
              data-selected={cue.id === state.selectedCueId}
              data-active={cue.id === activeCueId}
            >
              <button
                className="cue-time"
                title="Ir para esta legenda"
                onClick={() => {
                  store.selectCue(cue.id)
                  player?.seek(cue.startMs)
                }}
              >
                {formatTimecode(cue.startMs)}
              </button>
              <textarea
                className="cue-text"
                aria-label={`Legenda em ${formatTimecode(cue.startMs)}`}
                rows={1}
                maxLength={CAPTION_LIMITS.maxTextLength}
                value={store.textOf(cue)}
                onFocus={() => {
                  store.selectCue(cue.id)
                  player?.seek(cue.startMs)
                }}
                onChange={(event) => store.setCueText(cue.id, event.target.value)}
                onBlur={() => store.endGesture()}
              />
              <button
                className="region-row-remove"
                aria-label="Remover esta legenda"
                title="Remover esta legenda"
                onClick={() => store.removeCue(cue.id)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Refazer a transcrição">
        <p className="panel-hint">
          Use só se o texto original saiu errado. O idioma aqui é o que foi <strong>falado na gravação</strong>,
          não o idioma de destino: para traduzir a legenda, use "Idioma da legenda", mais acima.
        </p>
        {source}
        {activity ?? (
          <button className="panel-button" onClick={() => void generate(true)}>
            <RefreshIcon /> Transcrever de novo
          </button>
        )}
        <button className="panel-button panel-button-danger" onClick={() => store.removeCaptions()}>
          <TrashIcon /> Remover legendas
        </button>
        <p className="panel-hint">
          Transcrever de novo substitui o texto, inclusive as correções e as traduções.
        </p>
      </Section>
    </>
  )
}
