import { useState, useSyncExternalStore } from 'react'
import { formatTimecode } from '@shared/format'
import type { EditorSession } from '@shared/models/editor'
import type { Layer, SplitAudio, SplitOrientation, SplitShow, VideoLayer } from '@shared/models/project'
import { LAYER_LIMITS, SPLIT_LIMITS, isFileLayer } from '@shared/models/project'
import { layerLabel } from '@engine/rendering/shapes'
import { LayerIcon } from './LayerIcon'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { ArrowDownIcon, ArrowUpIcon, FilmIcon, PlusIcon, TrashIcon } from './icons'
import { Section, Segmented, Slider } from './panelControls'

interface Props {
  session: EditorSession
  store: EditorStore
  player: PreviewPlayer | null
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/**
 * Images over the video: logos, stickers, screenshots. Each is one of the
 * session's images laid over the picture for a span, moved and sized on
 * the preview and in time on the timeline. The list is the pile, top first.
 */
export function LayersPanel({ session, store, player }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { layers, images, clips, selectedLayerId } = state
  // A shape or an emoji is selected on the Elementos tool; here only a file layer has settings.
  const selected = layers.filter(isFileLayer).find((layer) => layer.id === selectedLayerId) ?? null
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileName = (file: string): string => images.find((image) => image.file === file)?.name ?? clips.find((clip) => clip.file === file)?.name ?? file
  const nameOf = (layer: Layer): string => layerLabel(layer, fileName)
  const clipOf = (file: string) => clips.find((clip) => clip.file === file) ?? null

  /** Brings clips in as b-roll, each laid over the video from the playhead, the last chosen on top. */
  const addClips = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const result = await window.screenrx.clips.import(session.sessionId).catch(() => null)
    setBusy(false)
    if (!result?.ok) {
      setNotice(result?.error.message ?? 'Não foi possível trazer o vídeo.')
      return
    }
    if (result.value.length === 0) return
    store.setClips([...store.getState().clips, ...result.value])
    let lastId = ''
    store.runAsOneStep(() => {
      for (const clip of result.value) lastId = store.addVideoLayer(clip.file, player?.currentTimeMs ?? 0)
    })
    if (lastId) store.selectLayer(lastId)
  }

  /** Brings images in and lays each over the video, the last chosen on top. */
  const addImages = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const result = await window.screenrx.images.import(session.sessionId).catch(() => null)
    setBusy(false)
    if (!result?.ok) {
      setNotice(result?.error.message ?? 'Não foi possível trazer a imagem.')
      return
    }
    if (result.value.length === 0) return
    const known = [...store.getState().images, ...result.value]
    store.setImages(known)
    let lastId = ''
    store.runAsOneStep(() => {
      for (const image of result.value) lastId = store.addImageLayer(image.file)
    })
    if (lastId) store.selectLayer(lastId)
  }

  /** Removes the layer and, when nothing else shows its file, the file too. */
  const remove = async (layer: Layer): Promise<void> => {
    store.removeLayer(layer.id)
    if (!isFileLayer(layer)) return
    const { file } = layer
    if (store.usesImage(file)) return
    if (clipOf(file)) {
      const result = await window.screenrx.clips.remove(session.sessionId, file).catch(() => null)
      if (result?.ok) store.setClips(store.getState().clips.filter((clip) => clip.file !== file))
      return
    }
    const result = await window.screenrx.images.remove(session.sessionId, file).catch(() => null)
    if (result?.ok) store.setImages(store.getState().images.filter((image) => image.file !== file))
  }

  return (
    <>
      <Section
        title={`Camadas${layers.length > 0 ? ` (${layers.length})` : ''}`}
        help="Um logo, um sticker, uma captura ou um trecho de outro vídeo por cima da gravação. A imagem entra o vídeo inteiro; o vídeo, a partir do play. As formas e os emojis também ficam nesta pilha. A primeira da lista fica por cima."
      >
        <div className="cut-actions">
          <button className="panel-button panel-button-primary" disabled={busy} onClick={() => void addImages()}>
            <PlusIcon /> {busy ? 'Trazendo…' : 'Imagem…'}
          </button>
          <button className="panel-button" disabled={busy || !player} title="Outro vídeo, a partir do play, na trilha Vídeo 2: por cima da gravação ou em tela dividida" onClick={() => void addClips()}>
            <FilmIcon /> Vídeo…
          </button>
        </div>
        {notice && <p className="panel-notice">{notice}</p>}
        {layers.length > 0 && (
          <ul className="region-list">
            {[...layers].reverse().map((layer, position) => (
              <li key={layer.id} className="region-row" data-selected={layer.id === selectedLayerId}>
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
                  <span className="text-row-label">{nameOf(layer)}</span>
                  <span className="region-row-meta">
                    {layer.startMs === 0 && layer.endMs >= session.durationMs ? 'o vídeo todo' : `${formatTimecode(layer.startMs)} – ${formatTimecode(layer.endMs)}`}
                  </span>
                </button>
                <button
                  className="region-row-remove"
                  aria-label="Trazer para a frente"
                  title="Trazer para a frente"
                  disabled={position === 0}
                  onClick={() => store.reorderLayer(layer.id, 'up')}
                >
                  <ArrowUpIcon />
                </button>
                <button
                  className="region-row-remove"
                  aria-label="Levar para trás"
                  title="Levar para trás"
                  disabled={position === layers.length - 1}
                  onClick={() => store.reorderLayer(layer.id, 'down')}
                >
                  <ArrowDownIcon />
                </button>
                <button
                  className="region-row-remove"
                  aria-label="Remover esta camada"
                  title="Remover esta camada"
                  onClick={() => void remove(layer)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {selected && (
        <Section
          title={selected.kind === 'video' ? 'Vídeo selecionado' : 'Imagem selecionada'}
          aside={fileName(selected.file)}
          help="Arraste no vídeo para posicionar e puxe um canto para redimensionar. Na linha do tempo, mude quando aparece."
        >
          <p className="panel-meta">
            {formatTimecode(selected.startMs)} – {formatTimecode(selected.endMs)}
            {!(selected.startMs === 0 && selected.endMs >= session.durationMs) && (
              <button className="field-link" onClick={() => store.stretchLayer(selected.id)}>
                O vídeo todo
              </button>
            )}
          </p>
          {selected.kind === 'video' && (
            <Slider
              label="Começar o clipe em"
              value={formatTimecode(selected.offsetMs)}
              min={0}
              max={Math.max(0, (clipOf(selected.file)?.durationMs ?? 0) - 100)}
              step={100}
              current={selected.offsetMs}
              onChange={(offsetMs) => store.setLayerOffset(selected.id, offsetMs, 'layer-offset')}
              onCommit={() => store.endGesture()}
            />
          )}
          {selected.kind === 'video' && (
            <label className="check">
              <input type="checkbox" checked={selected.split !== undefined} onChange={(event) => store.setLayerSplit(selected.id, event.target.checked)} />
              <span>Tela dividida com a gravação</span>
            </label>
          )}
          {selected.kind === 'video' && selected.split ? (
            <SplitControls layer={selected} hasAudio={clipOf(selected.file)?.hasAudio === true} store={store} />
          ) : (
            <>
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
            </>
          )}
          <button className="panel-button panel-button-danger" onClick={() => void remove(selected)}>
            <TrashIcon /> Remover {selected.kind === 'video' ? 'vídeo' : 'imagem'}
          </button>
        </Section>
      )}
    </>
  )
}

const ORIENTATIONS: ReadonlyArray<{ value: SplitOrientation; label: string }> = [
  { value: 'stacked', label: 'Em cima e embaixo' },
  { value: 'side', label: 'Lado a lado' }
]

const SPLIT_SHOW_OPTIONS: ReadonlyArray<{ value: SplitShow; label: string }> = [
  { value: 'both', label: 'Os dois' },
  { value: 'main', label: 'Só o 1' },
  { value: 'clip', label: 'Só o 2' }
]

const SPLIT_SOUNDS: ReadonlyArray<{ value: SplitAudio; label: string }> = [
  { value: 'main', label: 'Só o 1' },
  { value: 'both', label: 'Os dois' },
  { value: 'clip', label: 'Só o 2' }
]

/** How a clip shares the frame with the recording: the split, each part's framing, the line and the sound. */
function SplitControls({ layer, hasAudio, store }: { layer: VideoLayer; hasAudio: boolean; store: EditorStore }) {
  const split = layer.split
  if (!split) return null
  const stacked = split.orientation === 'stacked'
  const set = (change: Parameters<EditorStore['setSplit']>[1], gesture: string | null = null): void => store.setSplit(layer.id, change, gesture)
  const end = (): void => store.endGesture()
  // Each part is cut across the split's other axis: a stacked split moves the picture sideways, a side one up and down.
  const axis: 'x' | 'y' = stacked ? 'x' : 'y'
  return (
    <>
      <Segmented label="Mostrar neste trecho" value={split.show ?? 'both'} options={SPLIT_SHOW_OPTIONS} onChange={(show) => set({ show })} />
      <Segmented label="Divisão" value={split.orientation} options={ORIENTATIONS} onChange={(orientation) => set({ orientation })} />
      <p className="panel-meta">
        {stacked ? (split.clipFirst ? 'Clipe em cima, gravação embaixo' : 'Gravação em cima, clipe embaixo') : split.clipFirst ? 'Clipe à esquerda, gravação à direita' : 'Gravação à esquerda, clipe à direita'}
        <button className="field-link" onClick={() => set({ clipFirst: !split.clipFirst })}>
          Trocar de lugar
        </button>
      </p>
      <Slider
        label="Espaço da gravação"
        value={percent(split.mainShare)}
        min={SPLIT_LIMITS.minShare}
        max={SPLIT_LIMITS.maxShare}
        step={0.01}
        current={split.mainShare}
        onChange={(mainShare) => set({ mainShare }, 'split-share')}
        onCommit={end}
      />
      <Slider
        label={stacked ? 'Enquadrar a gravação (lados)' : 'Enquadrar a gravação (altura)'}
        value={percent(split.mainFocus[axis])}
        min={0}
        max={1}
        step={0.01}
        current={split.mainFocus[axis]}
        onChange={(value) => set({ mainFocus: { ...split.mainFocus, [axis]: value } }, 'split-main-focus')}
        onCommit={end}
      />
      <Slider
        label={stacked ? 'Enquadrar o clipe (lados)' : 'Enquadrar o clipe (altura)'}
        value={percent(split.clipFocus[axis])}
        min={0}
        max={1}
        step={0.01}
        current={split.clipFocus[axis]}
        onChange={(value) => set({ clipFocus: { ...split.clipFocus, [axis]: value } }, 'split-clip-focus')}
        onCommit={end}
      />
      <div className="color-row">
        <Slider
          label="Linha"
          value={split.dividerRatio === 0 ? 'Sem' : percent(split.dividerRatio / SPLIT_LIMITS.maxDividerRatio)}
          min={0}
          max={SPLIT_LIMITS.maxDividerRatio}
          step={0.001}
          current={split.dividerRatio}
          onChange={(dividerRatio) => set({ dividerRatio }, 'split-divider')}
          onCommit={end}
        />
        <label className="color-field">
          <input type="color" aria-label="Cor da linha" value={split.dividerColor} onChange={(event) => set({ dividerColor: event.target.value }, 'split-divider-color')} onBlur={end} />
          <span>Cor</span>
        </label>
      </div>
      {hasAudio ? (
        <>
          <Segmented label="Som (o vídeo 2 inteiro)" value={split.audio} options={SPLIT_SOUNDS} onChange={(audio) => set({ audio })} />
          {split.audio !== 'main' && (
            <Slider
              label="Volume do vídeo 2"
              value={percent(split.clipVolume)}
              min={0}
              max={SPLIT_LIMITS.maxClipVolume}
              step={0.05}
              current={split.clipVolume}
              onChange={(clipVolume) => set({ clipVolume }, 'split-volume')}
              onCommit={end}
            />
          )}
        </>
      ) : (
        <p className="panel-hint">Este clipe está sem som. Clipes trazidos antes desta versão vieram sem áudio: adicione o vídeo de novo para poder ouvi-lo.</p>
      )}
    </>
  )
}
