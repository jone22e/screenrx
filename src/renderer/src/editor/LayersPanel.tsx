import { useState, useSyncExternalStore } from 'react'
import { formatTimecode } from '@shared/format'
import type { EditorSession } from '@shared/models/editor'
import { LAYER_LIMITS } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { ArrowDownIcon, ArrowUpIcon, FilmIcon, ImageIcon, PlusIcon, TrashIcon } from './icons'
import { Section, Slider } from './panelControls'

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
  const selected = layers.find((layer) => layer.id === selectedLayerId) ?? null
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const nameOf = (file: string): string => images.find((image) => image.file === file)?.name ?? clips.find((clip) => clip.file === file)?.name ?? file
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

  /** Removes the layer and, when nothing else shows the file, the file too. */
  const remove = async (layerId: string, file: string): Promise<void> => {
    store.removeLayer(layerId)
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
        help="Um logo, um sticker, uma captura ou um trecho de outro vídeo por cima da gravação. A imagem entra o vídeo inteiro; o vídeo, a partir do play. A primeira da lista fica por cima."
      >
        <div className="cut-actions">
          <button className="panel-button panel-button-primary" disabled={busy} onClick={() => void addImages()}>
            <PlusIcon /> {busy ? 'Trazendo…' : 'Imagem…'}
          </button>
          <button className="panel-button" disabled={busy || !player} title="Um trecho de outro vídeo por cima da gravação, a partir do play, sem o som dele" onClick={() => void addClips()}>
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
                    {layer.kind === 'video' ? <FilmIcon /> : <ImageIcon />}
                  </span>
                  <span className="text-row-label">{nameOf(layer.file)}</span>
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
                  aria-label="Remover esta imagem"
                  title="Remover esta imagem"
                  onClick={() => void remove(layer.id, layer.file)}
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
          aside={nameOf(selected.file)}
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
          <button className="panel-button panel-button-danger" onClick={() => void remove(selected.id, selected.file)}>
            <TrashIcon /> Remover {selected.kind === 'video' ? 'vídeo' : 'imagem'}
          </button>
        </Section>
      )}
    </>
  )
}
