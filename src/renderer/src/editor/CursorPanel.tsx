import { useSyncExternalStore } from 'react'
import type { EditorSession } from '@shared/models/editor'
import type { CursorSmoothing } from '@shared/models/project'
import { CURSOR_LIMITS } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import { Section, Segmented, Slider } from './panelControls'

interface Props {
  session: EditorSession
  store: EditorStore
}

const SMOOTHINGS: ReadonlyArray<{ value: CursorSmoothing; label: string }> = [
  { value: 'none', label: 'Como gravado' },
  { value: 'light', label: 'Leve' },
  { value: 'strong', label: 'Forte' }
]

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/**
 * The pointer as the editor draws it from the recording's telemetry: an
 * arrow bigger than the system's, steadied, scaling with the zoom, with a
 * ring on each click. Only for recordings made without the system cursor
 * in the picture.
 */
export function CursorPanel({ session, store }: Props) {
  const { cursor } = useSyncExternalStore(store.subscribe, store.getState)

  if (session.cursorInVideo || session.cursor.length === 0) {
    return (
      <Section title="Cursor">
        <p className="panel-hint">
          {session.cursorInVideo
            ? 'Esta gravação tem o cursor do sistema na própria imagem: foi feita antes de o ScreenRx desenhar o cursor, ou veio de um arquivo. Nas gravações novas o cursor é desenhado aqui, maior e mais suave, e dá para ajustar.'
            : 'Esta gravação não tem o rastro do mouse, então não há cursor para desenhar.'}
        </p>
      </Section>
    )
  }

  return (
    <>
      <Section title="Cursor">
        <label className="check">
          <input type="checkbox" checked={cursor.visible} onChange={(event) => store.setCursor({ visible: event.target.checked })} />
          <span>Mostrar o cursor</span>
        </label>
        <p className="panel-hint">
          Desenhado a partir do rastro gravado, por cima da imagem: cresce junto com o zoom e nunca fica borrado.
        </p>
      </Section>

      {cursor.visible && (
        <Section title="Aparência">
          <Slider
            label="Tamanho"
            value={percent(cursor.sizeRatio / CURSOR_LIMITS.maxSizeRatio)}
            min={CURSOR_LIMITS.minSizeRatio}
            max={CURSOR_LIMITS.maxSizeRatio}
            step={0.0025}
            current={cursor.sizeRatio}
            onChange={(sizeRatio) => store.setCursor({ sizeRatio }, 'cursor-size')}
            onCommit={() => store.endGesture()}
          />
          <Segmented label="Suavizar o movimento" value={cursor.smoothing} options={SMOOTHINGS} onChange={(smoothing) => store.setCursor({ smoothing })} />
          <p className="panel-hint">Suavizar tira o tremor da mão; forte demais atrasa o cursor um instante em relação ao clique.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={cursor.clickHighlight}
              onChange={(event) => store.setCursor({ clickHighlight: event.target.checked })}
            />
            <span>Destacar os cliques</span>
          </label>
          <p className="panel-hint">Um anel que se abre a cada clique, para quem assiste ver onde você clicou.</p>
        </Section>
      )}
    </>
  )
}
