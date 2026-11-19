# ScreenRx

Gravador e editor de tela não destrutivo para desktop (macOS 14+).

Arquitetura, modelos, riscos e estado das fases: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requisitos

- macOS 14 ou superior, Xcode (toolchain Swift)
- Legendas automáticas: macOS 26 ou superior (reconhecimento de fala do sistema)
- Node.js 22.12+

## Desenvolvimento

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` compila os helpers nativos (captura e transcrição) e abre o app com hot reload.

A dublagem usa um terceiro helper, compilado à parte porque leva alguns minutos na
primeira vez (precisa de um Mac com Apple Silicon):

```bash
npm run build:voice
```

Sem ele o app funciona normalmente e apenas não oferece dublagem. O modelo de voz
(1,14 GB) não faz parte do projeto nem do instalador: é baixado por dentro do app.

O macOS exige a permissão de Gravação de Tela. Em desenvolvimento ela não aparece
como "ScreenRx": pertence ao aplicativo que executou o `npm run dev` (Terminal,
VS Code, Claude…). A janela principal mostra qual é; ative-o em Ajustes do Sistema ›
Privacidade e Segurança › Gravação do Áudio do Sistema e da Tela.

As gravações ficam em `~/Movies/ScreenRx/`, uma pasta por sessão. Os logs ficam em
`~/Library/Logs/ScreenRx/main.log`.

### Editor web

O editor também roda no navegador, sem os recursos que dependem do Mac
(biblioteca, IA, dublagem, efeitos renderizados, rastreamento de objeto e a
telemetria do cursor). Grava a tela pela própria página no Chrome e no Edge:

```bash
npm run dev:web
```

Abre em `http://localhost:5180`. `npm run build:web` gera `out/web/`, uma página
estática. O vídeo (MP4 ou MOV) é aberto como arquivo e a edição e a exportação
acontecem no navegador (WebCodecs: Chrome, Edge ou Safari 16.4+); o projeto fica
no IndexedDB.

**Servidor** (`src/server`): serve a página e, quando aponta para um serviço de
transcrição compatível com a API de áudio da OpenAI (OpenAI, Groq ou um Whisper
próprio), gera as legendas. Só o som vai ao servidor, como WAV mono de 16 kHz.

```bash
npm run build:web && npm run build:server
```

```bash
SCREENRX_TRANSCRIPTION_URL=https://api.openai.com/v1 SCREENRX_TRANSCRIPTION_KEY=sk-… npm run start:server
```

Em `http://localhost:8080`. Sem `SCREENRX_TRANSCRIPTION_URL` a aba Legendas só
importa SRT/VTT. Variáveis: `PORT`, `HOST`, `SCREENRX_WEB_DIR`,
`SCREENRX_TRANSCRIPTION_MODEL` (`whisper-1`), `_MAX_MINUTES` (120),
`_CHUNK_MINUTES` (1), `_CONCURRENCY` (2), `_TIMEOUT_SECONDS` (300). Em
desenvolvimento, `npm run dev:web` encaminha `/api` para `localhost:8080`.

Para hospedar tudo em casa: `docker compose up -d` sobe a página e um Whisper
(speaches) ao lado; o `Dockerfile` serve sozinho para usar um serviço de nuvem.
Coloque atrás de HTTPS: WebCodecs e o acesso a arquivos exigem contexto seguro.

## Gravar reuniões do Screen Live

Em Configurações, informe o endereço do Screen Live (ex.: `https://meet.exemplo.com`) e o
token de gravação (`API_RECORDER_TOKEN` do servidor). A biblioteca passa a listar as reuniões
em andamento; Gravar entra na sala como gravador numa janela própria e grava essa janela; o áudio
da reunião é capturado dentro da própria página (o macOS não entrega o áudio dessa janela à captura de
tela) e vira a trilha de som do sistema da gravação. Quem está na reunião vê o aviso "Gravando". Finalize pela barra de gravação ou
fechando a janela da reunião.

## Instalador (macOS)

```bash
make build-mac
```

Equivale a `npm run dist` e gera `release/ScreenRx-<versão>-arm64.dmg` (Apple Silicon), com os helpers nativos
e o FFmpeg dentro do app. A assinatura é local ("ad hoc"): o app abre neste Mac,
mas em outro Mac o macOS o bloqueia até ser liberado manualmente, e as permissões
(Gravação de Tela, microfone, câmera) são pedidas de novo a cada nova versão.

```bash
make check
```

Equivale a `npm run dist:check`: abre o app empacotado e confere o que só existe no pacote (helpers, FFmpeg, ícone).

Para distribuir a outras pessoas, `npm run dist:signed` assina com o certificado
"Developer ID Application" do Chaveiro (com hardened runtime), sem notarizar.

## Atualização automática

```bash
make update
```

Assina, notariza e publica uma versão nova em `jone22e/screenrx`; os apps instalados baixam e instalam sozinhos.
Passo a passo, pré-requisitos e problemas comuns em [docs/RELEASE.md](docs/RELEASE.md).

## Verificação

| Comando | O que faz |
| --- | --- |
| `npm run typecheck` | TypeScript (main, preload, renderer) |
| `npm run lint` | ESLint |
| `npm test` | Testes unitários (Vitest) |
| `npm run test:native` | Testes do helper Swift |
| `npm run test:voice` | Testes do helper de voz (após `npm run build:voice`) |
| `npm run check` | Todos os anteriores |
| `npm run build` | Build de produção em `out/` |
| `npm run dist:check` | Teste do app empacotado, após `npm run dist` |
| `npm run test:e2e` | Fluxo real de gravação, edição e exportação, após `npm run build`. Grava a tela por alguns segundos em uma pasta temporária; requer `ffmpeg`/`ffprobe` no PATH. |
