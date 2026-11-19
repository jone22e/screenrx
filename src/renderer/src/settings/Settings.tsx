import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AiProvider } from '@shared/models/ai'
import { AI_EFFORT_LABELS, choiceFor, effortsOf, readyProvider } from '@shared/models/ai'
import { formatBytes } from '@shared/format'
import { AiLogo } from '../common/AiLogo'
import { aiSettings } from '../common/aiSettings'
import { meetSettings, useMeetSettings } from '../common/meetSettings'
import { updateStatus, useUpdateStatus } from '../common/updateStatus'
import { voiceModel } from '../common/voiceModel'
import { instagramAccount } from '../common/instagramAccount'
import type { InstagramStatus } from '@shared/models/instagram'
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

/** The version running, whether a newer one exists, and a way to look for it now. */
const expiryFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * Instagram: the Meta app the login goes through (its id, and its secret so
 * the access lasts), then Facebook's login in a window of its own. What is
 * published goes to the professional account linked to a Facebook Page.
 */
function InstagramSection() {
  const status = useSyncExternalStore(instagramAccount.subscribe, instagramAccount.getState)
  const [draft, setDraft] = useState<{ appId: string; appSecret: string; configId: string } | null>(null)
  const [busy, setBusy] = useState<'save' | 'login' | 'token' | 'disconnect' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [token, setToken] = useState('')

  useEffect(() => {
    void instagramAccount.load()
  }, [])

  const current = draft ?? { appId: status?.appId ?? '', appSecret: '', configId: status?.configId ?? '' }
  const dirty = status !== null && (current.appId !== status.appId || current.appSecret !== '' || current.configId !== status.configId)

  const run = async (kind: NonNullable<typeof busy>, call: () => Promise<{ ok: true; value: InstagramStatus } | { ok: false; error: { message: string; detail?: string } }>): Promise<boolean> => {
    setBusy(kind)
    setFailure(null)
    try {
      const result = await call()
      if (result.ok) {
        instagramAccount.set(result.value)
        return true
      }
      setFailure(result.error.detail ? `${result.error.message} (${result.error.detail})` : result.error.message)
      return false
    } finally {
      setBusy(null)
    }
  }
  const save = async (): Promise<boolean> => {
    if (!dirty) return true
    const done = await run('save', () => window.screenrx.instagram.configure(current.appId, current.appSecret, current.configId))
    if (done) setDraft(null)
    return done
  }
  const login = async (): Promise<void> => {
    if (await save()) await run('login', () => window.screenrx.instagram.login())
  }
  const connectToken = async (): Promise<void> => {
    if ((await save()) && (await run('token', () => window.screenrx.instagram.connectWithToken(token)))) {
      setToken('')
      setPasting(false)
    }
  }

  const account = status?.account ?? null
  const choices = status?.choices ?? []
  const switchAccount = (): void => void run('login', () => window.screenrx.instagram.login(true))
  const field = (key: 'appId' | 'appSecret' | 'configId', value: string): void => setDraft({ ...current, [key]: value })

  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div>
          <h2>Instagram</h2>
          <p>Publica como Reels os vídeos que você aprovar na biblioteca. Precisa de uma conta Comercial ou de Criador ligada a uma Página do Facebook.</p>
        </div>
      </header>

      <div className="agent" data-instagram-connected={account !== null}>
        {choices.length > 0 && (
          <div className="instagram-choices" role="group" aria-label="Escolha a conta">
            <span>Escolha a conta:</span>
            {choices.map((choice) => (
              <button
                key={choice.igUserId}
                className={choice.igUserId === account?.igUserId ? 'settings-button settings-button-primary' : 'settings-button'}
                title={`Página ${choice.pageName || choice.pageId}`}
                disabled={busy !== null}
                onClick={() => void run('login', () => window.screenrx.instagram.choose(choice.igUserId))}
              >
                @{choice.username}
              </button>
            ))}
          </div>
        )}
        {account ? (
          <div className="instagram-account">
            <div>
              <strong>@{account.username}</strong>
              <small>
                Página {account.pageName || account.pageId} ·{' '}
                {status?.expiresAt ? `acesso até ${expiryFormat.format(new Date(status.expiresAt))}` : 'acesso sem prazo'}
              </small>
            </div>
            <button className="settings-button" disabled={busy !== null} title="Abre o login do Facebook de novo para escolher outras Páginas e contas" onClick={switchAccount}>
              {busy === 'login' ? 'Esperando o login…' : 'Trocar de conta'}
            </button>
            <button className="settings-button" disabled={busy !== null} onClick={() => void run('disconnect', () => window.screenrx.instagram.disconnect())}>
              Desconectar
            </button>
          </div>
        ) : (
          <>
            <ol className="instagram-steps">
              <li>
                Em{' '}
                <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">
                  developers.facebook.com/apps
                </a>
                , crie um app com o caso de uso <em>Gerenciar mensagens e conteúdo no Instagram</em> e adicione as permissões de conteúdo (Configuração da API com login do Facebook).
              </li>
              <li>
                Em Login do Facebook para Empresas › Configurações, ative <em>Login OAuth no navegador incorporado</em> e coloque <code>https://localhost/screenrx/instagram</code> nas URIs de redirecionamento.
              </li>
              <li>Em Login do Facebook para Empresas › Configurações, crie uma configuração com token de usuário e essas permissões. Cole aqui o ID do app, a Chave secreta (Configurações do app › Básico) e o ID da configuração, e conecte.</li>
            </ol>
            <div className="agent-options">
              <label className="agent-field">
                <span>ID do app</span>
                <input type="text" inputMode="numeric" placeholder="1234567890" value={current.appId} disabled={status === null} onChange={(event) => field('appId', event.target.value)} />
              </label>
              <label className="agent-field">
                <span>Chave secreta do app</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={status?.hasAppSecret ? '•••••••• (guardada)' : 'Opcional'}
                  value={current.appSecret}
                  disabled={status === null}
                  onChange={(event) => field('appSecret', event.target.value)}
                />
                <small>Com ela o acesso não expira. Fica no Chaveiro deste Mac.</small>
              </label>
              <label className="agent-field">
                <span>ID da configuração</span>
                <input type="text" inputMode="numeric" placeholder="Só para Login para Empresas" value={current.configId} disabled={status === null} onChange={(event) => field('configId', event.target.value)} />
              </label>
            </div>
            <div className="meet-actions">
              <button className="settings-button settings-button-primary" disabled={busy !== null || current.appId.trim() === ''} onClick={() => void login()}>
                {busy === 'login' ? 'Esperando o login…' : 'Conectar com o Facebook'}
              </button>
              <button className="settings-button" disabled={busy !== null} onClick={() => setPasting((open) => !open)}>
                Colar um token
              </button>
              {dirty && (
                <button className="settings-button" disabled={busy !== null} onClick={() => void save()}>
                  Salvar
                </button>
              )}
            </div>
            {pasting && (
              <div className="meet-actions">
                <input
                  className="instagram-token"
                  type="password"
                  autoComplete="off"
                  placeholder="Token de usuário do Explorador da Graph API"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <button className="settings-button settings-button-primary" disabled={busy !== null || token.trim() === ''} onClick={() => void connectToken()}>
                  {busy === 'token' ? 'Conectando…' : 'Conectar'}
                </button>
              </div>
            )}
          </>
        )}
        {failure && (
          <p className="agent-failure" role="alert">
            {failure}
          </p>
        )}
      </div>
    </section>
  )
}

function UpdateSection() {
  const update = useUpdateStatus()
  const [restartRefused, setRestartRefused] = useState(false)
  if (!update) return null

  const busy = update.status === 'checking' || update.status === 'downloading'
  const summary =
    update.status === 'unsupported'
      ? 'Disponível só no app instalado.'
      : update.status === 'checking'
        ? 'Procurando uma versão nova…'
        : update.status === 'downloading'
          ? `Baixando a versão ${update.version ?? ''} · ${update.percent ?? 0}%`
          : update.status === 'ready'
            ? `A versão ${update.version ?? ''} está pronta e será instalada quando você fechar o app.`
            : update.status === 'error'
              ? (update.error ?? 'Não foi possível verificar atualizações.')
              : 'Você está na versão mais recente.'

  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div>
          <h2>Atualização</h2>
          <p>
            O app procura versões novas sozinho, baixa em segundo plano e instala quando você o fecha. Nada é
            instalado durante uma gravação.
          </p>
        </div>
      </header>

      <div className="agent">
        <div className="agent-head">
          <div className="agent-name">
            <strong>ScreenRx {update.current}</strong>
            <span>{summary}</span>
          </div>
          {update.status !== 'unsupported' &&
            (update.status === 'ready' ? (
              <button
                className="settings-button settings-button-primary"
                onClick={() => void updateStatus.install().then((started) => setRestartRefused(!started))}
              >
                Reiniciar agora
              </button>
            ) : (
              <button className="settings-button" disabled={busy} onClick={() => void updateStatus.check()}>
                Verificar agora
              </button>
            ))}
        </div>
        {restartRefused && (
          <p className="agent-failure" role="alert">
            Termine a gravação ou a exportação em andamento para reiniciar.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The settings screen: the app's updates, the meeting app, the AI tools (which are installed
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
        <UpdateSection />

        <InstagramSection />

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
                        <AiLogo provider={provider.id} size={18} />
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
