import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AiProvider } from '@shared/models/ai'
import { AI_EFFORT_LABELS, choiceFor, effortsOf, readyProvider } from '@shared/models/ai'
import { formatBytes } from '@shared/format'
import { aiSettings } from '../common/aiSettings'
import { meetSettings, useMeetSettings } from '../common/meetSettings'
import { voiceModel } from '../common/voiceModel'
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
 * The meeting app (Screen Live): its address and the recorder token, kept by
 * the main process. Edits stay local until "Salvar".
 */
function MeetSection() {
  const { settings, saving, failure } = useMeetSettings()
  const [draft, setDraft] = useState<{ baseUrl: string; token: string } | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void meetSettings.load()
  }, [])

  const current = draft ?? settings ?? { baseUrl: '', token: '' }
  const dirty = settings !== null && (current.baseUrl !== settings.baseUrl || current.token !== settings.token)

  const save = async (): Promise<void> => {
    if (await meetSettings.save(current)) {
      setDraft(null)
      setSaved(true)
    }
  }

  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div>
          <h2>Reuniões (Screen Live)</h2>
          <p>
            Com o endereço do Screen Live e o token de gravação (<code>API_RECORDER_TOKEN</code> do servidor), a
            biblioteca lista as reuniões em andamento e grava uma delas: o app entra na sala como gravador, numa
            janela própria, e grava essa janela com o áudio. Quem está na reunião vê o aviso "Gravando".
          </p>
        </div>
      </header>

      <div className="agent" data-meet-configured={settings !== null && settings.baseUrl !== '' && settings.token !== ''}>
        <div className="agent-options">
          <label className="agent-field">
            <span>Endereço</span>
            <input
              type="url"
              placeholder="https://meet.exemplo.com"
              value={current.baseUrl}
              disabled={settings === null}
              onChange={(event) => {
                setSaved(false)
                setDraft({ ...current, baseUrl: event.target.value })
              }}
            />
            <small>Só o domínio, sem /live ou /api.</small>
          </label>
          <label className="agent-field">
            <span>Token de gravação</span>
            <input
              type="password"
              autoComplete="off"
              placeholder="API_RECORDER_TOKEN"
              value={current.token}
              disabled={settings === null}
              onChange={(event) => {
                setSaved(false)
                setDraft({ ...current, token: event.target.value })
              }}
            />
            <small>Fica neste Mac, nos dados do app. Nunca é mostrado de novo depois de salvo.</small>
          </label>
        </div>
        <div className="meet-actions">
          <button className="settings-button settings-button-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
          {saved && !dirty && <span className="meet-saved">Salvo.</span>}
        </div>
        {failure && (
          <p className="agent-failure" role="alert">
            {failure}
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The settings screen: the meeting app, the AI tools (which are installed
 * and signed in, installing and signing in from here, and which tool, model
 * and effort the app's AI features use) and the dubbing voice model.
 */
export function Settings({ onClose }: Props) {
  const state = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const { providers, preferences, activity, failure, checking } = state
  const inUse = providers ? readyProvider(providers, preferences) : null

  const voice = useSyncExternalStore(voiceModel.subscribe, voiceModel.getState)

  useEffect(() => {
    void aiSettings.load()
    void voiceModel.refresh()
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
        <MeetSection />

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

        <section className="settings-section">
          <header className="settings-section-head">
            <div>
              <h2>Dublagem</h2>
              <p>
                A sua voz falando outro idioma: o app aprende o seu timbre a partir do microfone da gravação e
                fala as legendas traduzidas. Tudo roda neste Mac; a sua voz não é enviada para lugar nenhum.
              </p>
            </div>
          </header>

          <div className="agent" data-voice-model={voice.status?.model ?? 'unknown'}>
            <div className="agent-head">
              <div className="agent-name">
                <strong>Modelo de voz</strong>
                <span>OmniVoice · inglês, espanhol, chinês, português e outros</span>
              </div>
              <span
                className="agent-status"
                data-readiness={voice.status?.model === 'ready' ? 'ready' : 'missing'}
              >
                {voice.status === null
                  ? 'Verificando…'
                  : !voice.status.available
                    ? 'Indisponível'
                    : voice.status.model === 'ready'
                      ? 'Baixado'
                      : 'Não baixado'}
              </span>
            </div>

            {voice.status && !voice.status.available ? (
              <p className="agent-account">A dublagem precisa de um Mac com Apple Silicon e do componente de voz desta versão.</p>
            ) : voice.progress ? (
              <div className="agent-busy" role="status">
                <span className="agent-spinner" aria-hidden="true" />
                <span>
                  {voice.progress.stage === 'unpacking' ? 'Preparando o modelo…' : 'Baixando o modelo de voz…'}{' '}
                  {Math.round(voice.progress.fraction * 100)}%
                </span>
                <button className="settings-button" onClick={() => voiceModel.cancel()}>
                  Cancelar
                </button>
              </div>
            ) : voice.status?.model === 'ready' ? (
              <div className="agent-setup">
                <p>Pronto para dublar. O modelo ocupa cerca de 2 GB em disco.</p>
                <button className="settings-button" onClick={() => void voiceModel.remove()}>
                  Remover
                </button>
              </div>
            ) : voice.status ? (
              <div className="agent-setup">
                <p>
                  Um download de {formatBytes(voice.status.modelDownloadBytes)}, feito uma única vez. Nada é
                  baixado antes de você pedir.
                </p>
                <button className="settings-button settings-button-primary" onClick={() => void voiceModel.download()}>
                  Baixar · {formatBytes(voice.status.modelDownloadBytes)}
                </button>
              </div>
            ) : null}

            {voice.failure && (
              <p className="agent-failure" role="alert">
                {voice.failure}
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
