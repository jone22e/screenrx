import { useSyncExternalStore } from 'react'
import { CAPTION_FONTS } from '@engine/captions/captionConfig'
import { formatTimecode } from '@shared/format'
import { TEXT_MOTION_LABELS } from '@engine/rendering/animation'
import { TEXT_TEMPLATES } from '@engine/rendering/textTemplates'
import type { CaptionBackdrop, CaptionFont, TextMotionKind } from '@shared/models/project'
import { CAPTION_FONT_IDS, CAPTION_LIMITS, TEXT_LIMITS, TEXT_MOTION_KINDS, TEXT_MOTION_LIMITS } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { PlusIcon, TrashIcon } from './icons'
import { Section, Segmented, Slider } from './panelControls'

interface Props {
  store: EditorStore
  player: PreviewPlayer | null
}

const BACKDROPS: ReadonlyArray<{ value: CaptionBackdrop; label: string }> = [
  { value: 'shadow', label: 'Sombra' },
  { value: 'box', label: 'Caixa' },
  { value: 'outline', label: 'Contorno' },
  { value: 'none', label: 'Nenhum' }
]

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

const MOTIONS: ReadonlyArray<{ value: TextMotionKind; label: string }> = TEXT_MOTION_KINDS.map((kind) => ({ value: kind, label: TEXT_MOTION_LABELS[kind] }))

/**
 * Texts written over the video: titles, call-outs. Each has its own span,
 * look and place; it is moved by dragging on the preview and in time on
 * the timeline.
 */
export function TextPanel({ store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { texts, selectedTextId } = state
  const selected = texts.find((text) => text.id === selectedTextId) ?? null

  const show = (id: string): void => {
    const text = store.getState().texts.find((candidate) => candidate.id === id)
    if (text && player) player.seek(text.startMs)
  }
  const add = (): void => show(store.addText(player?.currentTimeMs ?? 0))

  return (
    <>
      <Section title={`Texto${texts.length > 0 ? ` (${texts.length})` : ''}`} help="Um título ou um aviso sobre o vídeo, no instante que você quiser. Escolha um estilo para adicionar.">
        <button className="panel-button panel-button-primary" disabled={!player} onClick={add}>
          <PlusIcon /> Adicionar texto
        </button>
        <div className="looks" role="group" aria-label="Textos prontos">
          {TEXT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              className="look"
              title={template.hint}
              disabled={!player}
              onClick={() => show(store.addTextFromTemplate(template, player?.currentTimeMs ?? 0))}
            >
              <span className="look-sample">
                <span
                  style={{
                    fontFamily: CAPTION_FONTS[template.style.font].family,
                    fontWeight: template.style.bold ? 700 : 500,
                    color: template.style.color,
                    textTransform: template.style.uppercase ? 'uppercase' : 'none',
                    fontSize: template.id === 'title' ? 17 : 13
                  }}
                >
                  Aa
                </span>
              </span>
              <span className="look-name">{template.label}</span>
            </button>
          ))}
        </div>
        {texts.length > 0 && (
          <ul className="region-list">
            {texts.map((text) => (
              <li key={text.id} className="region-row" data-selected={text.id === selectedTextId}>
                <button
                  className="region-row-main"
                  onClick={() => {
                    store.selectText(text.id)
                    player?.seek(text.startMs)
                  }}
                >
                  <span className="text-row-label">{text.text || 'Sem texto'}</span>
                  <span className="region-row-meta">{formatTimecode(text.startMs)}</span>
                </button>
                <button
                  className="region-row-remove"
                  aria-label="Remover este texto"
                  title="Remover este texto"
                  onClick={() => store.removeText(text.id)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {selected && (
        <>
          <Section title="Texto selecionado" help="Arraste no vídeo para posicionar; na linha do tempo, para mudar quando aparece.">
            <p className="panel-meta">
              {formatTimecode(selected.startMs)} – {formatTimecode(selected.endMs)}
            </p>
            <textarea
              className="text-input"
              aria-label="Texto"
              rows={2}
              maxLength={TEXT_LIMITS.maxTextLength}
              value={selected.text}
              onChange={(event) => store.setTextContent(selected.id, event.target.value)}
              onBlur={() => store.endGesture()}
            />
          </Section>

          <Section title="Animação">
            <Segmented
              label="Entrada"
              value={selected.enter.kind}
              options={MOTIONS}
              onChange={(kind) => store.setTextMotion(selected.id, 'enter', { kind })}
            />
            {selected.enter.kind !== 'none' && (
              <Slider
                label="Duração da entrada"
                value={seconds(selected.enter.durationMs)}
                min={100}
                max={TEXT_MOTION_LIMITS.maxDurationMs}
                step={50}
                current={selected.enter.durationMs}
                onChange={(durationMs) => store.setTextMotion(selected.id, 'enter', { durationMs }, 'text-enter')}
                onCommit={() => store.endGesture()}
              />
            )}
            <Segmented
              label="Saída"
              value={selected.exit.kind}
              options={MOTIONS}
              onChange={(kind) => store.setTextMotion(selected.id, 'exit', { kind })}
            />
            {selected.exit.kind !== 'none' && (
              <Slider
                label="Duração da saída"
                value={seconds(selected.exit.durationMs)}
                min={100}
                max={TEXT_MOTION_LIMITS.maxDurationMs}
                step={50}
                current={selected.exit.durationMs}
                onChange={(durationMs) => store.setTextMotion(selected.id, 'exit', { durationMs }, 'text-exit')}
                onCommit={() => store.endGesture()}
              />
            )}
          </Section>

          <Section title="Estilo">
            <label className="field">
              <span className="field-label">Fonte</span>
              <select
                className="select"
                value={selected.style.font}
                onChange={(event) => store.setTextStyle(selected.id, { font: event.target.value as CaptionFont })}
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
              value={percent(selected.style.sizeRatio / CAPTION_LIMITS.maxSizeRatio)}
              min={CAPTION_LIMITS.minSizeRatio}
              max={CAPTION_LIMITS.maxSizeRatio}
              step={0.0025}
              current={selected.style.sizeRatio}
              onChange={(sizeRatio) => store.setTextStyle(selected.id, { sizeRatio }, 'text-size')}
              onCommit={() => store.endGesture()}
            />

            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.style.bold}
                  onChange={(event) => store.setTextStyle(selected.id, { bold: event.target.checked })}
                />
                <span>Negrito</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.style.uppercase}
                  onChange={(event) => store.setTextStyle(selected.id, { uppercase: event.target.checked })}
                />
                <span>Maiúsculas</span>
              </label>
            </div>

            <Segmented
              label="Fundo do texto"
              value={selected.style.backdrop}
              options={BACKDROPS}
              onChange={(backdrop) => store.setTextStyle(selected.id, { backdrop })}
            />

            <div className="color-row">
              <label className="color-field">
                <input
                  type="color"
                  aria-label="Cor do texto"
                  value={selected.style.color}
                  onChange={(event) => store.setTextStyle(selected.id, { color: event.target.value }, 'text-color')}
                  onBlur={() => store.endGesture()}
                />
                <span>Texto</span>
              </label>
              {(selected.style.backdrop === 'box' || selected.style.backdrop === 'outline') && (
                <label className="color-field">
                  <input
                    type="color"
                    aria-label={selected.style.backdrop === 'box' ? 'Cor da caixa' : 'Cor do contorno'}
                    value={selected.style.backdropColor}
                    onChange={(event) =>
                      store.setTextStyle(selected.id, { backdropColor: event.target.value }, 'text-backdrop-color')
                    }
                    onBlur={() => store.endGesture()}
                  />
                  <span>{selected.style.backdrop === 'box' ? 'Caixa' : 'Contorno'}</span>
                </label>
              )}
            </div>
          </Section>
        </>
      )}
    </>
  )
}
