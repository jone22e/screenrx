import { useEffect, useState } from 'react'
import type { ProjectTemplate } from '@shared/models/template'
import { TEMPLATE_LIMITS } from '@shared/models/template'
import type { EditorStore } from './EditorStore'
import { CheckIcon, TrashIcon } from './icons'
import { Section } from './panelControls'
import { FRAME_ASPECT_LABELS } from './frameAspects'

/**
 * Project templates: the look and settings of this edit saved under a name,
 * to put over the next recording in one click. Kept by the main process,
 * outside any recording.
 */
export function TemplatesSection({ store }: { store: EditorStore }) {
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.screenrx.templates.list().then(setTemplates)
  }, [])

  const save = async (): Promise<void> => {
    const name = naming?.trim() ?? ''
    if (name === '') return
    const result = await window.screenrx.templates.save(store.templateNamed(name)).catch(() => null)
    if (!result?.ok) {
      setNotice(result?.error.message ?? 'Não foi possível salvar o modelo.')
      return
    }
    setTemplates(result.value)
    setNaming(null)
    setNotice(`Modelo “${name}” salvo.`)
  }

  const remove = async (template: ProjectTemplate): Promise<void> => {
    const result = await window.screenrx.templates.delete(template.id).catch(() => null)
    if (result?.ok) setTemplates(result.value)
  }

  return (
    <Section title={`Modelos${templates && templates.length > 0 ? ` (${templates.length})` : ''}`}>
      {templates && templates.length > 0 && (
        <ul className="region-list">
          {templates.map((template) => (
            <li key={template.id} className="region-row">
              <button
                className="region-row-main"
                title={`${FRAME_ASPECT_LABELS[template.background.aspect]} · legenda ${template.captions.style.mode === 'block' ? 'clássica' : 'palavra a palavra'} · ${template.export.preset === 'custom' ? 'exportação manual' : template.export.preset}`}
                onClick={() => {
                  store.applyTemplate(template)
                  setNotice(`Modelo “${template.name}” aplicado.`)
                }}
              >
                <span className="text-row-label">{template.name}</span>
                <span className="region-row-meta">{FRAME_ASPECT_LABELS[template.background.aspect]}</span>
              </button>
              <button className="region-row-remove" aria-label={`Apagar o modelo ${template.name}`} title="Apagar este modelo" onClick={() => void remove(template)}>
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      {naming === null ? (
        <button className="panel-button" disabled={(templates?.length ?? 0) >= TEMPLATE_LIMITS.maxTemplates} onClick={() => setNaming('')}>
          <CheckIcon /> Salvar este visual como modelo…
        </button>
      ) : (
        <div className="cut-actions">
          <input
            className="text-input"
            aria-label="Nome do modelo"
            placeholder="Nome do modelo"
            autoFocus
            maxLength={TEMPLATE_LIMITS.maxNameLength}
            value={naming}
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
              if (event.key === 'Escape') setNaming(null)
              event.stopPropagation()
            }}
          />
          <button className="panel-button panel-button-primary" disabled={naming.trim() === ''} onClick={() => void save()}>
            Salvar
          </button>
        </div>
      )}
      <p className="panel-hint">
        Fundo e formato, estilo das legendas, cursor, câmera, ajustes da música e da exportação. Cortes, legendas e
        imagens ficam de fora. Aplicar um modelo é um passo de desfazer.
      </p>
      {notice && <p className="panel-hint">{notice}</p>}
    </Section>
  )
}
