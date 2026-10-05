import { useEffect, useSyncExternalStore } from 'react'
import type { AiProvider } from '@shared/models/ai'
import { AI_EFFORT_LABELS, choiceFor, effortsOf, readyProvider } from '@shared/models/ai'
import { aiSettings } from '../common/aiSettings'
import './settings.css'

interface Props {
  onClose: () => void
}

type Readiness = 'ready' | 'signed-out' | 'missing'

const readinessOf = (provider: AiProvider): Readiness =>
  !provider.installed ? 'missing' : provider.loggedIn ? 'ready' : 'signed-out'

const READINESS_LABELS: Record<Readiness, string> = {
  ready: 'Pronto',
  'signed-out': 'Falta entrar',
  missing: 'Não instalado'
}

/**
 * The settings screen. For now it holds the AI tools: which are installed
 * and signed in, installing and signing in from here, and which tool, model
 * and effort the app's AI features use.
 */
export function Settings({ onClose }: Props) {
  const state = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const { providers, preferences, activity, failure, checking } = state
  const inUse = providers ? readyProvider(providers, preferences) : null

  useEffect(() => {
    void aiSettings.load()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Configurações">
      <header className="settings-bar">
        <button className="settings-back" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Voltar
        </button>
        <h1 className="settings-title">Configurações</h1>
      </header>

      <main className="settings-content">
        <section className="settings-section">
          <header className="settings-section-head">
            <div>
              <h2>Inteligência artificial</h2>
              <p>
                O ScreenRx usa as ferramentas de IA instaladas neste Mac, com a sua conta em cada uma. Nenhuma
                chave de API é guardada, e só o texto da transcrição é enviado quando você pede uma sugestão.
              </p>
            </div>
            <button className="settings-button" disabled={checking} onClick={() => void aiSettings.load(true)}>
              {checking ? 'Verificando…' : 'Verificar de novo'}
            </button>
          </header>

          {providers === null ? (
            <p className="settings-empty">Procurando as ferramentas de IA…</p>
          ) : (
            <ul className="agents">
              {providers.map((provider) => {
                const readiness = readinessOf(provider)
                const choice = choiceFor(provider, preferences)
                const model = provider.models.find((candidate) => candidate.id === choice.model)
                const busy = activity?.provider === provider.id ? activity.kind : null
                const used = inUse?.id === provider.id

                return (
                  <li key={provider.id} className="agent" data-agent={provider.id} data-readiness={readiness} data-used={used}>
                    <div className="agent-head">
                      <div className="agent-name">
                        <strong>{provider.label}</strong>
                        <span>
                          {provider.toolName}
                          {provider.version ? ` · versão ${provider.version}` : ''}
                        </span>
                      </div>
                      <span className="agent-status" data-readiness={readiness}>
                        {READINESS_LABELS[readiness]}
                      </span>
                    </div>

                    {provider.account && <p className="agent-account">{provider.account}</p>}

                    {busy ? (
                      <div className="agent-busy" role="status">
                        <span className="agent-spinner" aria-hidden="true" />
                        <span>
                          {busy === 'install'
                            ? `Instalando o ${provider.toolName}…`
                            : 'Conclua o login no navegador que foi aberto…'}
                        </span>
                        <button className="settings-button" onClick={() => aiSettings.cancelSetup()}>
                          Cancelar
                        </button>
                      </div>
                    ) : readiness === 'missing' ? (
                      <div className="agent-setup">
                        <p>Baixa e executa o instalador oficial. A ferramenta fica na sua pasta pessoal.</p>
                        <button
                          className="settings-button settings-button-primary"
                          disabled={activity !== null}
                          onClick={() => void aiSettings.install(provider.id)}
                        >
                          Instalar
                        </button>
                      </div>
                    ) : readiness === 'signed-out' ? (
                      <div className="agent-setup">
                        {provider.canLogIn ? (
                          <>
                            <p>Entre com a sua conta para usar. O login abre no navegador.</p>
                            <button
                              className="settings-button settings-button-primary"
                              disabled={activity !== null}
                              onClick={() => void aiSettings.login(provider.id)}
                            >
                              Entrar
                            </button>
                          </>
                        ) : (
                          <p>
                            Esta ferramenta entra na conta na primeira vez que roda: abra o Terminal, execute{' '}
                            <code>agy</code> e depois clique em "Verificar de novo".
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="agent-options">
                        <label className="agent-field">
                          <span>Modelo</span>
                          <select
                            aria-label={`Modelo do ${provider.label}`}
                            value={choice.model}
                            onChange={(event) => aiSettings.setModel(provider.id, event.target.value)}
                          >
                            {provider.models.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          {model?.description && <small>{model.description}</small>}
                        </label>

                        <div className="agent-field">
                          <span>Esforço</span>
                          <div className="efforts" role="radiogroup" aria-label={`Esforço do ${provider.label}`}>
                            {effortsOf(provider, choice.model).map((effort) => (
                              <button
                                key={effort}
                                className="effort"
                                role="radio"
                                aria-checked={effort === choice.effort}
                                onClick={() => aiSettings.setEffort(provider.id, effort)}
                              >
                                {AI_EFFORT_LABELS[effort]}
                              </button>
                            ))}
                          </div>
                          <small>Mais esforço pensa por mais tempo antes de responder.</small>
                        </div>

                        <button
                          className="agent-use"
                          role="radio"
                          aria-checked={used}
                          aria-label={`Usar ${provider.label}`}
                          onClick={() => aiSettings.useProvider(provider.id)}
                        >
                          <span className="agent-use-mark" aria-hidden="true" />
                          {used ? 'Em uso nas sugestões' : 'Usar nas sugestões'}
                        </button>
                      </div>
                    )}

                    {failure?.provider === provider.id && (
                      <p className="agent-failure" role="alert">
                        {failure.message}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
