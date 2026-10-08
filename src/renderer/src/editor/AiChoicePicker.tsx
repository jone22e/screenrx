import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AiProvider } from '@shared/models/ai'
import { AI_EFFORT_LABELS, effortsOf } from '@shared/models/ai'
import { AiLogo } from '../common/AiLogo'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { openSettings } from '../common/settingsScreen'
import { GearIcon } from './icons'

interface Props {
  disabled?: boolean
  /** Where the panel opens: above the chip (in the composer) or below it (in a panel). */
  placement?: 'above' | 'below'
}

const isReady = (provider: AiProvider): boolean => provider.installed && provider.loggedIn

/**
 * Which AI tool, model and effort the assistant asks: a chip that opens a
 * small panel with one tab per tool that is ready on this machine, the
 * tool's models and an effort slider. The choice is the same one the
 * settings screen and "Sugerir cortes" use.
 */
export function AiChoicePicker({ disabled = false, placement = 'above' }: Props) {
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // Closes on a click elsewhere or on Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!current) {
    return (
      <button className="ai-chip" onClick={openSettings}>
        <GearIcon /> Configurar IA
      </button>
    )
  }

  const ready = (ai.providers ?? []).filter(isReady)
  const { provider, choice } = current
  const model = provider.models.find((candidate) => candidate.id === choice.model)
  const efforts = effortsOf(provider, choice.model)
  const effortIndex = Math.max(0, efforts.indexOf(choice.effort))

  return (
    <div className="ai-picker" ref={root}>
      <button
        className="ai-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title="Ferramenta, modelo e esforço"
        onClick={() => setOpen((value) => !value)}
      >
        <AiLogo provider={provider.id} />
        <strong>{model?.label ?? (choice.model || provider.label)}</strong>
        <span>{AI_EFFORT_LABELS[choice.effort]}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
        </svg>
      </button>

      {open && (
        <div className="ai-popover" data-placement={placement} role="dialog" aria-label="Ferramenta de IA">
          <div className="ai-tabs" role="tablist">
            {ready.map((candidate) => (
              <button
                key={candidate.id}
                className="ai-tab"
                role="tab"
                aria-selected={candidate.id === provider.id}
                onClick={() => aiSettings.useProvider(candidate.id)}
              >
                <AiLogo provider={candidate.id} size={13} />
                {candidate.label}
              </button>
            ))}
          </div>

          <label className="ai-field">
            <span>Modelo</span>
            <select
              className="select"
              value={choice.model}
              onChange={(event) => aiSettings.setModel(provider.id, event.target.value)}
            >
              {provider.models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="ai-field">
            <span>
              Esforço <strong>{AI_EFFORT_LABELS[choice.effort]}</strong>
            </span>
            <input
              type="range"
              className="ai-effort"
              aria-label="Esforço"
              min={0}
              max={Math.max(0, efforts.length - 1)}
              step={1}
              value={effortIndex}
              onChange={(event) => {
                const effort = efforts[Number(event.target.value)]
                if (effort) aiSettings.setEffort(provider.id, effort)
              }}
            />
          </div>

          <button className="ai-popover-settings" onClick={openSettings}>
            <GearIcon /> Instalar ou entrar em outra ferramenta
          </button>
        </div>
      )}
    </div>
  )
}
