import type { CSSProperties, ReactNode } from 'react'
import { useState, useSyncExternalStore } from 'react'
import { BACKGROUND_PRESETS } from '@engine/rendering/backgrounds'
import { nextKeptSourceTime } from '@engine/time/timeMapping'
import { ZOOM_LIMITS } from '@engine/zoom/zoomConfig'
import { formatTimecode } from '@shared/format'
import type { EditorSession } from '@shared/models/editor'
import type { WebcamCorner, WebcamShape } from '@shared/models/project'
import { BACKGROUND_LIMITS, FRAME_LIMITS, WEBCAM_LIMITS } from '@shared/models/project'
import { AssistantPanel } from './AssistantPanel'
import { CaptionsPanel } from './CaptionsPanel'
import { DubbingPanel } from './DubbingSection'
import { EffectsPanel } from './EffectsPanel'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { SuggestionsPanel } from './SuggestionsPanel'
import { TextPanel } from './TextPanel'
import { AspectShapeIcon, FRAME_ASPECT_RATIOS, FRAME_FIT_ICONS } from './frameAspectIcons'
import { FRAME_ALIGN_OPTIONS, FRAME_ASPECT_OPTIONS, FRAME_FIT_HINTS, FRAME_FIT_OPTIONS, FRAME_FOLLOW_OPTIONS, aspectLabel, fitChoiceOf } from './frameAspects'
import { createExportPlan } from '@engine/export/exportPlan'
import { safeAreas, useSafeAreas } from '../common/safeAreas'
import { Section, Segmented, Slider } from './panelControls'
import {
  BackdropIcon,
  CameraIcon,
  FormatIcon,
  CaptionsIcon,
  VoiceIcon,
  PlusIcon,
  ScissorsIcon,
  SparklesIcon,
  TextIcon,
  TrashIcon,
  UndoIcon,
  WandIcon,
  ZoomIcon
} from './icons'

interface Props {
  session: EditorSession
  store: EditorStore
  player: PreviewPlayer | null
}

type Tab = 'assistant' | 'cuts' | 'zoom' | 'captions' | 'text' | 'dub' | 'format' | 'effects' | 'background' | 'webcam'

const decimal = (value: number, digits = 1): string => value.toFixed(digits).replace('.', ',')
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const seconds = (ms: number): string => `${decimal(ms / 1000)} s`

/**
 * The tools, as a rail of icons down the left edge — one per aspect of the
 * edit, plus the assistant — and the panel of the chosen one beside it.
 */
export function Sidebar({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [chosen, setChosen] = useState<Tab>('cuts')
  // Selecting a region on the timeline brings up its settings.
  const tab: Tab = state.selectedZoomId
    ? 'zoom'
    : state.selectedTrimId
      ? 'cuts'
      : state.selectedCueId
        ? 'captions'
        : state.selectedTextId
          ? 'text'
          : chosen

  const tabs: Array<{ id: Tab; label: string; icon: ReactNode }> = [
    { id: 'assistant', label: 'Assistente', icon: <SparklesIcon /> },
    { id: 'cuts', label: 'Cortes', icon: <ScissorsIcon /> },
    { id: 'zoom', label: 'Zoom', icon: <ZoomIcon /> },
    { id: 'captions', label: 'Legendas', icon: <CaptionsIcon /> },
    { id: 'text', label: 'Texto', icon: <TextIcon /> },
    { id: 'dub', label: 'Dublagem', icon: <VoiceIcon /> },
    { id: 'format', label: 'Formato', icon: <FormatIcon /> },
    { id: 'effects', label: 'Efeitos', icon: <WandIcon /> },
    { id: 'background', label: 'Fundo', icon: <BackdropIcon /> },
    ...(session.webcam ? [{ id: 'webcam' as const, label: 'Câmera', icon: <CameraIcon /> }] : [])
  ]
  const choose = (next: Tab): void => {
    store.select(null)
    setChosen(next)
  }

  return (
    <>
      <nav className="rail" role="tablist" aria-label="Ferramentas">
        {tabs.map(({ id, label, icon }) => (
          <button key={id} className="rail-item" role="tab" aria-selected={tab === id} aria-label={label} title={label} onClick={() => choose(id)}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <aside className="sidebar">
        {/* The assistant stays mounted, so its conversation and an answer on its way survive a change of tool. */}
        <div className="sidebar-assistant" hidden={tab !== 'assistant'}>
          <AssistantPanel store={store} />
        </div>
        <div className="sidebar-body" hidden={tab === 'assistant'}>
        {tab === 'cuts' && <CutsPanel session={session} store={store} player={player} />}
        {tab === 'zoom' && <ZoomPanel session={session} store={store} player={player} />}
        {tab === 'captions' && <CaptionsPanel session={session} store={store} player={player} />}
        {tab === 'text' && <TextPanel store={store} player={player} />}
        {tab === 'dub' && <DubbingPanel store={store} onOpenCaptions={() => choose('captions')} />}
        {tab === 'format' && <FormatPanel session={session} store={store} player={player} onOpenBackground={() => choose('background')} />}
        {tab === 'effects' && <EffectsPanel store={store} />}
        {tab === 'background' && <BackgroundPanel store={store} />}
        {tab === 'webcam' && <WebcamPanel store={store} />}
        </div>
      </aside>
    </>
  )
}

function CutsPanel({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { selection, trims, timeMap } = state
  const removedMs = session.durationMs - timeMap.timelineDurationMs
  const selectedMs = selection ? selection.endMs - selection.startMs : 0

  return (
    <>
      <Section title="Seleção">
        <div className="inout">
          <span className="inout-point" data-set={selection !== null}>
            <kbd>I</kbd>
            <span>{selection ? formatTimecode(selection.startMs) : '—'}</span>
          </span>
          <span className="inout-point" data-set={selection !== null}>
            <kbd>O</kbd>
            <span>{selection ? formatTimecode(selection.endMs) : '—'}</span>
          </span>
        </div>
        <div className="cut-actions">
          <button className="panel-button panel-button-primary" disabled={!selection} onClick={() => store.cutSelection()}>
            <ScissorsIcon /> Cortar{selection && ` ${seconds(selectedMs)}`}
            <kbd className="button-key">⌫</kbd>
          </button>
          <button
            className="panel-button"
            disabled={!player}
            title="Abre um corte de alguns segundos a partir da posição do play"
            onClick={() => player && store.addTrim(player.currentTimeMs)}
          >
            <ScissorsIcon /> Daqui
          </button>
        </div>
        <p className="panel-hint">Arraste na timeline ou marque com <kbd>I</kbd> e <kbd>O</kbd>.</p>
      </Section>

      <SuggestionsPanel store={store} player={player} />

      <Section title={`Cortes${trims.length > 0 ? ` (${trims.length})` : ''}`} aside={trims.length > 0 ? 'Clique para ir até o corte' : undefined}>
        {trims.length === 0 ? (
          <p className="panel-hint">Nenhum corte.</p>
        ) : (
          <ul className="cut-list">
            {trims.map((trim) => (
              <li key={trim.id} className="cut-row" data-selected={trim.id === state.selectedTrimId}>
                <button
                  className="cut-row-main"
                  onClick={() => {
                    store.selectTrim(trim.id)
                    player?.seek(trim.startMs)
                  }}
                >
                  <span className="cut-row-span">
                    {formatTimecode(trim.startMs)} – {formatTimecode(trim.endMs)}
                  </span>
                  <span className="cut-row-length">{seconds(trim.endMs - trim.startMs)}</span>
                </button>
                <button
                  className="region-row-remove"
                  aria-label="Desfazer este corte"
                  title="Desfazer este corte"
                  onClick={() => store.removeTrim(trim.id)}
                >
                  <UndoIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="cut-total">
        <span className="cut-total-text">
          <span>Duração final</span>
          <strong>{formatTimecode(timeMap.timelineDurationMs)}</strong>
        </span>
        {removedMs > 0 && <span className="cut-total-removed">−{seconds(removedMs)}</span>}
      </div>
    </>
  )
}

function ZoomPanel({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const zoom = state.zooms.find((candidate) => candidate.id === state.selectedZoomId)
  const hasClicks = session.interactions.length > 0

  if (zoom) {
    return (
      <Section title="Zoom selecionado">
        <p className="panel-meta">
          {formatTimecode(zoom.startMs)} – {formatTimecode(zoom.endMs)}
          <span className="badge">{zoom.mode === 'auto' ? 'Automático' : 'Manual'}</span>
        </p>
        <Slider
          label="Intensidade"
          value={`${decimal(zoom.scale)}×`}
          min={ZOOM_LIMITS.minScale}
          max={ZOOM_LIMITS.maxScale}
          step={0.1}
          current={zoom.scale}
          onChange={(scale) => store.setScale(zoom.id, scale)}
          onCommit={() => store.endGesture()}
        />
        <p className="panel-hint">Clique no vídeo para mudar o foco.</p>
        <button className="panel-button panel-button-danger" onClick={() => store.removeZoom(zoom.id)}>
          <TrashIcon /> Remover zoom
        </button>
      </Section>
    )
  }

  return (
    <Section title="Zoom">
      <p className="panel-hint">
        {state.zooms.length === 0
          ? 'Nenhum zoom.'
          : `${state.zooms.length} ${state.zooms.length === 1 ? 'zoom' : 'zooms'}. Selecione um para ajustar.`}
      </p>
      <button
        className="panel-button panel-button-primary"
        disabled={!player}
        onClick={() => player && store.addZoom(player.currentTimeMs)}
      >
        <PlusIcon /> Adicionar zoom aqui
      </button>
      <button
        className="panel-button"
        disabled={!hasClicks}
        title={
          hasClicks
            ? 'Recria os zooms a partir dos cliques gravados. Zooms que você criou ou ajustou são mantidos.'
            : 'Esta gravação não tem cliques registrados.'
        }
        onClick={() => store.regenerateAutoZooms()}
      >
        <SparklesIcon /> Regenerar zooms automáticos
      </button>
    </Section>
  )
}

/** The shape of the finished video, and how the recording goes into a vertical one. */
/** The shape of the finished video, how the recording goes into it, and where the apps' interface will cover it. */
function FormatPanel({ session, store, player, onOpenBackground }: Props & { onOpenBackground: () => void }) {
  const { background, timeMap, exportSettings, objectTrack, tracking, trackNotice, markingObject } = useSyncExternalStore(store.subscribe, store.getState)
  const safe = useSafeAreas()
  const source = { width: session.video.widthPx, height: session.video.heightPx }
  const plan = createExportPlan(source, timeMap, exportSettings, background.aspect)
  const vertical = background.aspect !== 'native'
  const filling = vertical && background.fit !== 'fit'
  const preset = BACKGROUND_PRESETS.find((candidate) => candidate.id === background.presetId)

  return (
    <>
      <Section title="Formato">
        <div className="format-grid" role="radiogroup" aria-label="Formato">
          {FRAME_ASPECT_OPTIONS.map((option) => (
            <button
              key={option.value}
              className="format-card"
              role="radio"
              aria-checked={option.value === background.aspect}
              onClick={() => store.setBackground({ aspect: option.value })}
            >
              <AspectShapeIcon ratio={option.value === 'native' ? source.width / source.height : FRAME_ASPECT_RATIOS[option.value]} />
              <span className="format-card-text">
                <strong>
                  {option.label} <span className="format-card-ratio">{option.ratio ?? aspectLabel(source.width, source.height)}</span>
                </strong>
                <span>{option.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </Section>

      {vertical && (
        <Section title="Enquadramento">
          <div className="fit-options" role="radiogroup" aria-label="Enquadramento">
            {FRAME_FIT_OPTIONS.map((option) => (
              <button
                key={option.value}
                className="fit-option"
                role="radio"
                aria-checked={option.value === fitChoiceOf(background.fit)}
                onClick={() => store.setBackground({ fit: option.value === 'follow' ? (session.cursor.length > 0 ? 'follow-mouse' : 'follow-zoom') : option.value })}
              >
                {FRAME_FIT_ICONS[option.value]}
                <span>{option.label}</span>
              </button>
            ))}
          </div>
          {fitChoiceOf(background.fit) === 'follow' && (
            <Segmented
              label="Seguir o"
              value={background.fit === 'follow-mouse' || background.fit === 'follow-object' ? background.fit : 'follow-zoom'}
              options={FRAME_FOLLOW_OPTIONS}
              onChange={(fit) => store.setBackground({ fit })}
            />
          )}
          {background.fit === 'follow-object' && (
            <div className="track-card">
              {tracking ? (
                <div className="progress" role="status">
                  <span className="progress-label">
                    Rastreando o objeto <strong>{percent(tracking.fraction)}</strong>
                  </span>
                  <span className="progress-track">
                    <span className="progress-fill" style={{ width: percent(tracking.fraction) }} />
                  </span>
                  <button className="panel-button" onClick={() => void window.screenrx.track.cancel()}>
                    Cancelar
                  </button>
                </div>
              ) : markingObject ? (
                <>
                  <p className="panel-hint">
                    Arraste um retângulo em volta do objeto no preview, no instante em que ele aparece. O rastreamento
                    começa daí.
                  </p>
                  <button className="panel-button" onClick={() => store.setMarkingObject(false)}>
                    Cancelar
                  </button>
                </>
              ) : (
                <>
                  <p className="panel-hint">
                    {objectTrack
                      ? `Objeto rastreado de ${formatTimecode(objectTrack.startMs)} a ${formatTimecode(objectTrack.endMs)}.`
                      : 'Nenhum objeto marcado ainda.'}
                  </p>
                  <button
                    className="panel-button panel-button-primary"
                    onClick={() => {
                      // Tracking goes forward from the marked frame; at the end of the video there is none to mark on.
                      if (player && player.currentTimeMs >= session.durationMs - 100) {
                        player.pause()
                        player.seek(nextKeptSourceTime(timeMap, 0) ?? 0)
                      }
                      store.setMarkingObject(true)
                    }}
                  >
                    {objectTrack ? 'Marcar de novo' : 'Marcar objeto'}
                  </button>
                </>
              )}
              {trackNotice && <p className="panel-notice">{trackNotice}</p>}
            </div>
          )}
          <p className="panel-hint">
            {FRAME_FIT_HINTS[background.fit]}
            {background.fit === 'follow-mouse' && session.cursor.length === 0 && ' Esta gravação não tem o rastro do mouse (foi importada ou é uma reunião), então a parte usada fica no centro.'}
          </p>

          <Slider
            label={filling ? 'Zoom' : 'Tamanho'}
            value={percent(filling ? background.scale : Math.min(background.scale, 1))}
            min={filling ? 1 : FRAME_LIMITS.minFitScale}
            max={filling ? FRAME_LIMITS.maxFillZoom : 1}
            step={0.01}
            current={filling ? Math.max(background.scale, 1) : Math.min(background.scale, 1)}
            onChange={(scale) => store.setBackground({ scale }, 'frame-scale')}
            onCommit={() => store.endGesture()}
          />
          {!filling && (
            <Segmented label="Posição" value={background.align} options={FRAME_ALIGN_OPTIONS} onChange={(align) => store.setBackground({ align })} />
          )}
          <div className="format-background">
            <span className="panel-hint">Fundo: {preset ? preset.name : 'Preto'}</span>
            <button className="field-link" onClick={onOpenBackground}>
              Alterar em Fundo
            </button>
          </div>
        </Section>
      )}

      {background.aspect === '9:16' && (
        <Section title="Áreas seguras">
          <label className="switch-row">
            <span className="switch-row-text">
              <strong>Mostrar áreas seguras</strong>
              <span>
                Desenha no preview, só como guia, as faixas que Reels, TikTok e Shorts cobrem com os próprios botões
                e legendas. Não sai na exportação.
              </span>
            </span>
            <input type="checkbox" role="switch" checked={safe} onChange={(event) => safeAreas.set(event.target.checked)} />
          </label>
        </Section>
      )}

      <div className="format-output">
        <span>Saída</span>
        <strong>
          {plan.width} × {plan.height} · {plan.fps} fps
        </strong>
      </div>
    </>
  )
}

function BackgroundPanel({ store }: { store: EditorStore }) {
  const { background } = useSyncExternalStore(store.subscribe, store.getState)
  const framed = background.presetId !== null

  return (
    <Section title="Fundo">
      <div className="swatches" role="radiogroup" aria-label="Fundo">
        <button
          className="swatch swatch-none"
          role="radio"
          aria-checked={!framed}
          aria-label="Sem fundo"
          title="Sem fundo"
          onClick={() => store.setBackground({ presetId: null })}
        />
        {BACKGROUND_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="swatch"
            role="radio"
            aria-checked={preset.id === background.presetId}
            aria-label={preset.name}
            title={preset.name}
            style={
              {
                background: `linear-gradient(${preset.angleDeg}deg, ${preset.colors.join(', ')})`
              } as CSSProperties
            }
            onClick={() => store.setBackground({ presetId: preset.id })}
          />
        ))}
      </div>

      {framed && (
        <>
          <Slider
            label="Margem"
            value={percent(background.paddingRatio)}
            min={0}
            max={BACKGROUND_LIMITS.maxPaddingRatio}
            step={0.005}
            current={background.paddingRatio}
            onChange={(paddingRatio) => store.setBackground({ paddingRatio }, 'padding')}
            onCommit={() => store.endGesture()}
          />
          <Slider
            label="Cantos"
            value={percent(background.cornerRadiusRatio / BACKGROUND_LIMITS.maxCornerRadiusRatio)}
            min={0}
            max={BACKGROUND_LIMITS.maxCornerRadiusRatio}
            step={0.001}
            current={background.cornerRadiusRatio}
            onChange={(cornerRadiusRatio) => store.setBackground({ cornerRadiusRatio }, 'corners')}
            onCommit={() => store.endGesture()}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={background.shadow}
              onChange={(event) => store.setBackground({ shadow: event.target.checked })}
            />
            <span>Sombra</span>
          </label>
        </>
      )}
    </Section>
  )
}

const SHAPES: ReadonlyArray<{ value: WebcamShape; label: string }> = [
  { value: 'circle', label: 'Círculo' },
  { value: 'rounded', label: 'Arredondada' },
  { value: 'square', label: 'Quadrada' }
]

const CORNERS: ReadonlyArray<{ value: WebcamCorner; label: string }> = [
  { value: 'top-left', label: 'Canto superior esquerdo' },
  { value: 'top-right', label: 'Canto superior direito' },
  { value: 'bottom-left', label: 'Canto inferior esquerdo' },
  { value: 'bottom-right', label: 'Canto inferior direito' }
]

function WebcamPanel({ store }: { store: EditorStore }) {
  const { webcam } = useSyncExternalStore(store.subscribe, store.getState)

  return (
    <Section title="Câmera">
      <label className="check">
        <input
          type="checkbox"
          checked={webcam.visible}
          onChange={(event) => store.setWebcam({ visible: event.target.checked })}
        />
        <span>Mostrar câmera</span>
      </label>

      {webcam.visible && (
        <>
          <Segmented
            label="Formato"
            value={webcam.shape}
            options={SHAPES.map((shape) => ({
              ...shape,
              icon: <span className="shape-icon" data-shape={shape.value} aria-hidden="true" />
            }))}
            onChange={(shape) => store.setWebcam({ shape })}
          />

          <div className="field">
            <span className="field-label">
              Posição <strong>{webcam.corner ? '' : 'Livre'}</strong>
            </span>
            <div className="corner-picker" role="radiogroup" aria-label="Posição da câmera">
              {CORNERS.map((corner) => (
                <button
                  key={corner.value}
                  className="corner"
                  data-corner={corner.value}
                  role="radio"
                  aria-checked={webcam.corner === corner.value}
                  aria-label={corner.label}
                  title={corner.label}
                  onClick={() => store.setWebcam({ corner: corner.value })}
                />
              ))}
            </div>
            <p className="panel-hint">Ou arraste no vídeo.</p>
          </div>

          <Slider
            label="Tamanho"
            value={percent(webcam.sizeRatio)}
            min={WEBCAM_LIMITS.minSizeRatio}
            max={WEBCAM_LIMITS.maxSizeRatio}
            step={0.01}
            current={webcam.sizeRatio}
            onChange={(sizeRatio) => store.setWebcam({ sizeRatio }, 'webcam-size')}
            onCommit={() => store.endGesture()}
          />

          <label className="check">
            <input
              type="checkbox"
              checked={webcam.border}
              onChange={(event) => store.setWebcam({ border: event.target.checked })}
            />
            <span>Borda</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={webcam.mirrored}
              onChange={(event) => store.setWebcam({ mirrored: event.target.checked })}
            />
            <span>Espelhar</span>
          </label>
        </>
      )}
    </Section>
  )
}
