/** Failure categories surfaced to the user. */
export type AppErrorCode =
  | 'screen-recording-permission-denied'
  | 'microphone-permission-denied'
  | 'camera-permission-denied'
  | 'device-unavailable'
  | 'source-unavailable'
  | 'no-source-selected'
  | 'capture-failed'
  | 'capture-stopped-by-system'
  | 'capture-helper-unavailable'
  | 'capture-helper-exited'
  | 'disk-full'
  | 'recording-invalid'
  | 'storage-unavailable'
  | 'export-failed'
  | 'export-cancelled'
  | 'export-busy'
  | 'transcription-failed'
  | 'transcription-unavailable'
  | 'transcription-cancelled'
  | 'transcription-busy'
  | 'ai-unavailable'
  | 'ai-failed'
  | 'ai-cancelled'
  | 'ai-busy'
  | 'ai-no-transcript'
  | 'ai-install-failed'
  | 'dub-unavailable'
  | 'dub-model-missing'
  | 'dub-download-failed'
  | 'dub-failed'
  | 'dub-cancelled'
  | 'dub-busy'
  | 'ai-login-failed'
  | 'platform-unsupported'
  | 'meet-not-configured'
  | 'meet-unreachable'
  | 'meet-unauthorized'
  | 'meet-failed'
  | 'meet-join-failed'
  | 'import-unsupported'
  | 'import-failed'
  | 'invalid-state'
  | 'unknown'

export interface AppError {
  code: AppErrorCode
  /** User-facing explanation. */
  message: string
  /** Technical detail for logs and bug reports. */
  detail?: string
}

/** Outcome of an IPC call that can fail in ways the UI must explain. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppError }

const MESSAGES: Record<AppErrorCode, string> = {
  'screen-recording-permission-denied':
    'O ScreenRx precisa da permissão de Gravação de Tela. Ative-a em Ajustes do Sistema › Privacidade e Segurança › Gravação de Tela.',
  'microphone-permission-denied':
    'O microfone não está autorizado. Ative-o em Ajustes do Sistema › Privacidade e Segurança › Microfone.',
  'camera-permission-denied':
    'A câmera não está autorizada. Ative-a em Ajustes do Sistema › Privacidade e Segurança › Câmera.',
  'device-unavailable': 'O microfone ou a câmera escolhidos não estão disponíveis.',
  'source-unavailable':
    'A tela ou janela escolhida não está mais disponível. Escolha outra fonte.',
  'no-source-selected': 'Escolha uma tela ou janela para gravar.',
  'capture-failed': 'A captura de tela falhou.',
  'capture-stopped-by-system':
    'A gravação foi encerrada pelo sistema. O que foi gravado até então foi salvo.',
  'capture-helper-unavailable':
    'O componente de captura não foi encontrado. Reinstale o aplicativo.',
  'capture-helper-exited':
    'O componente de captura parou inesperadamente e a gravação foi interrompida.',
  'disk-full': 'O disco ficou sem espaço e a gravação foi interrompida.',
  'recording-invalid': 'A gravação terminou, mas o arquivo gerado é inválido.',
  'storage-unavailable': 'Não foi possível gravar na pasta de gravações.',
  'export-failed': 'A exportação falhou.',
  'export-cancelled': 'A exportação foi cancelada.',
  'export-busy': 'Já existe uma exportação em andamento.',
  'transcription-failed': 'Não foi possível transcrever o áudio desta gravação.',
  'transcription-unavailable':
    'A transcrição não está disponível: ela precisa do macOS 26 ou mais recente e de um idioma suportado pelo sistema.',
  'transcription-cancelled': 'A transcrição foi cancelada.',
  'transcription-busy': 'Já existe uma transcrição em andamento.',
  'ai-unavailable': 'A ferramenta de IA não foi encontrada. Instale-a em Configurar IA.',
  'ai-failed':
    'A IA não respondeu como esperado. Confira se o login da ferramenta está ativo e tente de novo.',
  'ai-cancelled': 'A análise foi cancelada.',
  'ai-busy': 'Já existe uma análise em andamento.',
  'dub-unavailable': 'A dublagem não está disponível nesta versão do app (ela precisa de um Mac com Apple Silicon).',
  'dub-model-missing': 'O modelo de voz ainda não foi baixado. Baixe-o para gerar a dublagem.',
  'dub-download-failed': 'Não foi possível baixar o modelo de voz. Confira a conexão e tente de novo.',
  'dub-failed': 'Não foi possível gerar a dublagem.',
  'dub-cancelled': 'A dublagem foi cancelada.',
  'dub-busy': 'Já existe uma dublagem ou um download em andamento.',
  'ai-install-failed': 'A instalação não foi concluída.',
  'ai-login-failed': 'O login não foi concluído.',
  'ai-no-transcript': 'A IA lê a transcrição da fala. Gere as legendas desta gravação primeiro.',
  'platform-unsupported': 'A gravação ainda não é suportada neste sistema operacional.',
  'meet-not-configured': 'Informe o endereço do Screen Live e o token de gravação em Configurações.',
  'meet-unreachable': 'Não foi possível falar com o Screen Live. Confira o endereço e a conexão.',
  'meet-unauthorized': 'O Screen Live recusou o token de gravação. Confira-o em Configurações.',
  'meet-failed': 'O Screen Live respondeu de forma inesperada.',
  'meet-join-failed': 'Não foi possível entrar na reunião para gravar.',
  'import-unsupported': 'O arquivo escolhido não tem uma trilha de vídeo que o ScreenRx consiga ler.',
  'import-failed': 'Não foi possível importar o vídeo.',
  'invalid-state': 'Essa ação não está disponível no momento.',
  unknown: 'Ocorreu um erro inesperado.'
}

export function appError(code: AppErrorCode, detail?: string): AppError {
  return detail === undefined
    ? { code, message: MESSAGES[code] }
    : { code, message: MESSAGES[code], detail }
}
