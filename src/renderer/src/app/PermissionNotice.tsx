import type { PermissionReport } from '@shared/models/permissions'

interface Props {
  report: PermissionReport
  onRequest: () => void
}

export function PermissionNotice({ report, onRequest }: Props) {
  if (report.permissions.screenRecording === 'unsupported') {
    return (
      <div className="notice">
        <p>A gravação ainda não é suportada neste sistema operacional.</p>
      </div>
    )
  }

  const { name, isLauncher } = report.grantee
  return (
    <div className="notice">
      <div>
        <h2>Permissão de Gravação de Tela</h2>
        <p>
          Para gravar, ative <strong>{name ?? 'o aplicativo que iniciou o ScreenRx'}</strong> em
          Ajustes do Sistema › Privacidade e Segurança › Gravação do Áudio do Sistema e da Tela.
          Depois volte para esta janela.
        </p>
        {isLauncher && (
          <p>
            Nesta versão de desenvolvimento, o macOS atribui a permissão ao aplicativo que executou
            o <code>npm run dev</code>
            {name ? ` (${name})` : ' (Terminal, VS Code…)'}, e não ao ScreenRx. Se ele já estiver na
            lista, basta ligar a chave.
          </p>
        )}
      </div>
      <div className="notice-actions">
        <button className="button button-primary" onClick={onRequest}>
          Solicitar permissão
        </button>
        <button
          className="button"
          onClick={() => void window.screenrx.permissions.openSettings('screenRecording')}
        >
          Abrir Ajustes do Sistema
        </button>
      </div>
    </div>
  )
}
