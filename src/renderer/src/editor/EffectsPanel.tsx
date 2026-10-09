import { useSyncExternalStore } from 'react'
import type { FilterStrength, RenderedFilterName } from '@shared/models/filters'
import { colorChanged, needsRenderedTrack, renderKey } from '@shared/models/filters'
import type { EditorStore } from './EditorStore'
import { Section, Segmented, Slider } from './panelControls'

interface Props {
  store: EditorStore
}

const STRENGTH_OPTIONS: ReadonlyArray<{ value: FilterStrength; label: string }> = [
  { value: 'light', label: 'Leve' },
  { value: 'medium', label: 'Média' },
  { value: 'strong', label: 'Forte' }
]

/** The effects FFmpeg renders into the derived track, as shown. */
const RENDERED: ReadonlyArray<{ name: RenderedFilterName; title: string; label: string; hint: string }> = [
  {
    name: 'stabilization',
    title: 'Estabilização de câmera',
    label: 'Estabilizar a imagem',
    hint: 'Suaviza o balanço de uma gravação feita à mão. Para esconder as bordas que o movimento deixa vazias, a imagem é levemente aproximada.'
  },
  {
    name: 'denoise',
    title: 'Redução de ruído',
    label: 'Reduzir o ruído',
    hint: 'Ameniza o chuvisco de pouca luz e os blocos da compressão. Forte demais deixa a imagem com cara de pintura.'
  },
  {
    name: 'sharpen',
    title: 'Nitidez',
    label: 'Realçar os detalhes',
    hint: 'Reforça contornos e texto. Em imagem com ruído, use junto com a redução de ruído.'
  }
]

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/**
 * Effects on the picture. The rendered ones (stabilization, noise reduction,
 * sharpening) are applied by FFmpeg into a track of their own, made again
 * whenever they change; the colour is applied while drawing, at once. The
 * recording is never altered.
 */
export function EffectsPanel({ store }: Props) {
  const { filters, filterTrack, filtering, filterNotice } = useSyncExternalStore(store.subscribe, store.getState)
  const rendered = needsRenderedTrack(filters)
  const current = rendered && filterTrack?.key === renderKey(filters)
  const { color } = filters

  return (
    <>
      {RENDERED.map(({ name, title, label, hint }) => {
        const setting = filters[name]
        return (
          <Section key={name} title={title}>
            <label className="switch-row">
              <span className="switch-row-text">
                <strong>{label}</strong>
                <span>{hint}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={setting.enabled}
                onChange={(event) => store.setRenderedFilter(name, { enabled: event.target.checked })}
              />
            </label>
            {setting.enabled && (
              <Segmented
                label="Intensidade"
                value={setting.strength}
                options={STRENGTH_OPTIONS}
                onChange={(strength) => store.setRenderedFilter(name, { strength })}
              />
            )}
          </Section>
        )
      })}

      {(rendered || filtering || filterNotice) && (
        <Section title="Aplicação dos efeitos">
          {filtering ? (
            <div className="progress" role="status">
              <span className="progress-label">
                Aplicando os efeitos ao vídeo <strong>{percent(filtering.fraction)}</strong>
              </span>
              <span className="progress-track">
                <span className="progress-fill" style={{ width: percent(filtering.fraction) }} />
              </span>
              <button className="panel-button" onClick={() => void window.screenrx.filters.cancel()}>
                Cancelar
              </button>
            </div>
          ) : current ? (
            <p className="panel-hint" data-effects="applied">
              Efeitos aplicados: o preview e a exportação já mostram o vídeo com eles. A gravação original não
              foi alterada.
            </p>
          ) : rendered ? (
            <p className="panel-hint">Os efeitos serão aplicados ao vídeo em instantes.</p>
          ) : null}
          {filterNotice && <p className="panel-notice">{filterNotice}</p>}
        </Section>
      )}

      <Section
        title="Cor"
        aside={
          colorChanged(color) ? (
            <button className="field-link" onClick={() => store.resetColor()}>
              Restaurar
            </button>
          ) : undefined
        }
      >
        <Slider
          label="Brilho"
          value={percent(color.brightness)}
          min={0.5}
          max={1.5}
          step={0.01}
          current={color.brightness}
          onChange={(brightness) => store.setColor({ brightness }, 'color-brightness')}
          onCommit={() => store.endGesture()}
        />
        <Slider
          label="Contraste"
          value={percent(color.contrast)}
          min={0.5}
          max={1.5}
          step={0.01}
          current={color.contrast}
          onChange={(contrast) => store.setColor({ contrast }, 'color-contrast')}
          onCommit={() => store.endGesture()}
        />
        <Slider
          label="Saturação"
          value={percent(color.saturation)}
          min={0}
          max={2}
          step={0.01}
          current={color.saturation}
          onChange={(saturation) => store.setColor({ saturation }, 'color-saturation')}
          onCommit={() => store.endGesture()}
        />
        <label className="switch-row">
          <span className="switch-row-text">
            <strong>Preto e branco</strong>
            <span>Tira toda a cor. Vale para o preview e para a exportação, na hora.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={color.saturation === 0}
            onChange={(event) => store.setColor({ saturation: event.target.checked ? 0 : 1 })}
          />
        </label>
      </Section>
    </>
  )
}
