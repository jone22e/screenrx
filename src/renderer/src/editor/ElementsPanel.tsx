import { useState, useSyncExternalStore } from 'react'
import { EMOJI_PICKS, SHAPES, firstEmoji, layerLabel, shapeInfo, shapeSvgPath } from '@engine/rendering/shapes'
import { formatTimecode } from '@shared/format'
import type { EditorSession } from '@shared/models/editor'
import type { ShapeKind } from '@shared/models/project'
import { LAYER_LIMITS, SHAPE_LIMITS, isElementLayer } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import { LayerIcon } from './LayerIcon'
import type { PreviewPlayer } from './PreviewPlayer'
import { PlusIcon, TrashIcon } from './icons'
import { Section, Slider } from './panelControls'

interface Props {
  session: EditorSession
  store: EditorStore
  player: PreviewPlayer | null
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const ICON_BOX = { x: 2, y: 2, width: 28, height: 28 }

/** A shape's icon: the shape itself, traced as the canvas traces it, fitted in a square. */
function ShapeIcon({ kind }: { kind: ShapeKind }) {
  const info = shapeInfo(kind)
  // Wide shapes keep their proportions inside the square; the line is drawn thicker so it can be seen.
  const aspect = kind === 'line' ? 0.18 : info.aspect
  const height = ICON_BOX.height * Math.min(1, aspect)
  const width = ICON_BOX.width * Math.min(1, 1 / aspect)
  const box = { x: ICON_BOX.x + (ICON_BOX.width - width) / 2, y: ICON_BOX.y + (ICON_BOX.height - height) / 2, width, height }
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <path d={shapeSvgPath(kind, box, Math.min(width, height) * info.cornerRadiusRatio)} fill="currentColor" />
    </svg>
  )
}

/**
 * Shapes and emojis over the video: a box around a button, an arrow, a
 * thumbs-up. Each shows from the play position for a few seconds, is moved
 * and sized on the preview and in time on the timeline, and sits in the
 * same pile as the images (the Camadas tool orders them).
 */
export function ElementsPanel({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const elements = state.layers.filter(isElementLayer)
  const selected = elements.find((layer) => layer.id === state.selectedLayerId) ?? null
  const [typed, setTyped] = useState('')
  const full = state.layers.length >= LAYER_LIMITS.maxLayers

  const show = (id: string): void => {
    const layer = store.getState().layers.find((candidate) => candidate.id === id)
    if (layer && player) player.seek(layer.startMs)
  }
  const addShape = (kind: ShapeKind): void => show(store.addShapeLayer(kind, player?.currentTimeMs ?? 0))
  const addEmoji = (emoji: string): void => show(store.addEmojiLayer(emoji, player?.currentTimeMs ?? 0))
  const addTyped = (): void => {
    const emoji = firstEmoji(typed)
    if (!emoji) return
    addEmoji(emoji)
    setTyped('')
  }
  const wholeVideo = selected !== null && selected.startMs === 0 && selected.endMs >= session.durationMs

  return (
    <>
      <Section
        title={`Elementos${elements.length > 0 ? ` (${elements.length})` : ''}`}
        help="Uma forma ou um emoji sobre o vídeo, a partir do play. Arraste no vídeo para posicionar e puxe um canto para redimensionar; na linha do tempo, mude quando aparece."
      >
        <div className="looks looks-shapes" role="group" aria-label="Formas">
          {SHAPES.map((shape) => (
            <button key={shape.kind} className="look" title={shape.hint} disabled={!player || full} onClick={() => addShape(shape.kind)}>
              <span className="look-sample">
                <ShapeIcon kind={shape.kind} />
              </span>
              <span className="look-name">{shape.label}</span>
            </button>
          ))}
        </div>
        <div className="emoji-grid" role="group" aria-label="Emojis">
          {EMOJI_PICKS.map((emoji) => (
            <button key={emoji} className="emoji-pick" title={`Adicionar ${emoji}`} disabled={!player || full} onClick={() => addEmoji(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
        <div className="emoji-other">
          <input
            className="text-input"
            aria-label="Outro emoji"
            placeholder="Outro emoji…"
            maxLength={SHAPE_LIMITS.maxEmojiLength}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTyped()
              }
            }}
          />
          <button className="panel-button" disabled={!player || full || firstEmoji(typed) === null} onClick={addTyped}>
            <PlusIcon /> Adicionar
          </button>
        </div>
        {elements.length > 0 && (
          <ul className="region-list">
            {elements.map((layer) => (
              <li key={layer.id} className="region-row" data-selected={layer.id === state.selectedLayerId}>
                <button
                  className="region-row-main"
                  onClick={() => {
                    store.selectLayer(layer.id)
                    if (player && (player.currentTimeMs < layer.startMs || player.currentTimeMs >= layer.endMs)) player.seek(layer.startMs)
                  }}
                >
                  <span className="region-icon" aria-hidden="true">
                    <LayerIcon layer={layer} />
                  </span>
                  <span className="text-row-label">{layerLabel(layer, (file) => file)}</span>
                  <span className="region-row-meta">{formatTimecode(layer.startMs)}</span>
                </button>
                <button className="region-row-remove" aria-label="Remover este elemento" title="Remover este elemento" onClick={() => store.removeLayer(layer.id)}>
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {selected && (
        <Section
          title={selected.kind === 'shape' ? 'Forma selecionada' : 'Emoji selecionado'}
          aside={layerLabel(selected, (file) => file)}
          help="Arraste no vídeo para posicionar e puxe um canto para redimensionar. Na linha do tempo, mude quando aparece."
        >
          <p className="panel-meta">
            {formatTimecode(selected.startMs)} – {formatTimecode(selected.endMs)}
            {!wholeVideo && (
              <button className="field-link" onClick={() => store.stretchLayer(selected.id)}>
                O vídeo todo
              </button>
            )}
          </p>

          {selected.kind === 'shape' ? (
            <>
              <div className="looks looks-shapes" role="group" aria-label="Trocar a forma">
                {SHAPES.map((shape) => (
                  <button
                    key={shape.kind}
                    className="look"
                    title={shape.hint}
                    aria-pressed={shape.kind === selected.shape}
                    onClick={() => store.setShape(selected.id, { shape: shape.kind, aspect: shape.aspect })}
                  >
                    <span className="look-sample">
                      <ShapeIcon kind={shape.kind} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="color-row">
                <label className="color-field">
                  <input
                    type="checkbox"
                    aria-label="Preencher"
                    checked={selected.fill}
                    onChange={(event) => store.setShape(selected.id, { fill: event.target.checked })}
                  />
                  <input
                    type="color"
                    aria-label="Cor do preenchimento"
                    value={selected.fillColor}
                    disabled={!selected.fill}
                    onChange={(event) => store.setShape(selected.id, { fillColor: event.target.value }, 'shape-fill')}
                    onBlur={() => store.endGesture()}
                  />
                  <span>Preenchimento</span>
                </label>
                <label className="color-field">
                  <input
                    type="color"
                    aria-label="Cor do contorno"
                    value={selected.strokeColor}
                    onChange={(event) => store.setShape(selected.id, { strokeColor: event.target.value }, 'shape-stroke')}
                    onBlur={() => store.endGesture()}
                  />
                  <span>Contorno</span>
                </label>
              </div>
              <Slider
                label="Contorno"
                value={selected.strokeRatio === 0 ? 'nenhum' : percent(selected.strokeRatio / SHAPE_LIMITS.maxStrokeRatio)}
                min={0}
                max={SHAPE_LIMITS.maxStrokeRatio}
                step={0.001}
                current={selected.strokeRatio}
                onChange={(strokeRatio) => store.setShape(selected.id, { strokeRatio }, 'shape-stroke-width')}
                onCommit={() => store.endGesture()}
              />
              <Slider
                label="Altura"
                value={`${percent(selected.aspect)} da largura`}
                min={SHAPE_LIMITS.minAspect}
                max={SHAPE_LIMITS.maxAspect}
                step={0.01}
                current={selected.aspect}
                onChange={(aspect) => store.setShape(selected.id, { aspect }, 'shape-aspect')}
                onCommit={() => store.endGesture()}
              />
            </>
          ) : (
            <input
              className="text-input emoji-input"
              aria-label="Emoji"
              maxLength={SHAPE_LIMITS.maxEmojiLength}
              value={selected.emoji}
              onChange={(event) => {
                const emoji = firstEmoji(event.target.value)
                if (emoji) store.setEmoji(selected.id, emoji)
              }}
            />
          )}

          <Slider
            label="Tamanho"
            value={percent(selected.sizeRatio)}
            min={LAYER_LIMITS.minSizeRatio}
            max={LAYER_LIMITS.maxSizeRatio}
            step={0.005}
            current={selected.sizeRatio}
            onChange={(sizeRatio) => store.setLayer(selected.id, { sizeRatio }, 'layer-size')}
            onCommit={() => store.endGesture()}
          />
          <Slider
            label="Opacidade"
            value={percent(selected.opacity)}
            min={0}
            max={1}
            step={0.01}
            current={selected.opacity}
            onChange={(opacity) => store.setLayer(selected.id, { opacity }, 'layer-opacity')}
            onCommit={() => store.endGesture()}
          />
          <Slider
            label="Rotação"
            value={`${Math.round(selected.rotationDeg > 180 ? selected.rotationDeg - 360 : selected.rotationDeg)}°`}
            min={-180}
            max={180}
            step={1}
            current={selected.rotationDeg > 180 ? selected.rotationDeg - 360 : selected.rotationDeg}
            onChange={(rotationDeg) => store.setLayer(selected.id, { rotationDeg }, 'layer-rotation')}
            onCommit={() => store.endGesture()}
          />
          {selected.kind === 'shape' && shapeInfo(selected.shape).rounded && (
            <Slider
              label="Cantos"
              value={percent(selected.cornerRadiusRatio / LAYER_LIMITS.maxCornerRadiusRatio)}
              min={0}
              max={LAYER_LIMITS.maxCornerRadiusRatio}
              step={0.01}
              current={selected.cornerRadiusRatio}
              onChange={(cornerRadiusRatio) => store.setLayer(selected.id, { cornerRadiusRatio }, 'layer-corners')}
              onCommit={() => store.endGesture()}
            />
          )}
          <button className="panel-button panel-button-danger" onClick={() => store.removeLayer(selected.id)}>
            <TrashIcon /> Remover {selected.kind === 'shape' ? 'forma' : 'emoji'}
          </button>
        </Section>
      )}
    </>
  )
}
