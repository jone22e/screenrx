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
            ? 'O cursor já está na imagem desta gravação; não há o que desenhar.'
            : 'Sem rastro do mouse nesta gravação.'}
        </p>
      </Section>
    )
  }

  return (
    <>
      <Section title="Cursor" help="Desenhado por cima da imagem a partir do rastro gravado: cresce com o zoom e nunca fica borrado.">
        <label className="check">
          <input type="checkbox" checked={cursor.visible} onChange={(event) => store.setCursor({ visible: event.target.checked })} />
          <span>Mostrar o cursor</span>
        </label>
      </Section>

      {cursor.visible && (
        <Section title="Aparência" help="Suavizar tira o tremor da mão; forte demais atrasa o cursor em relação ao clique. Destacar abre um anel a cada clique.">
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
          <label className="check">
            <input
              type="checkbox"
              checked={cursor.clickHighlight}
              onChange={(event) => store.setCursor({ clickHighlight: event.target.checked })}
            />
            <span>Destacar os cliques</span>
          </label>
        </Section>
      )}
    </>
  )
}
