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

## Instalador (macOS)

```bash
npm run dist
```

Gera `release/ScreenRx-<versão>-arm64.dmg` (Apple Silicon), com os helpers nativos
e o FFmpeg dentro do app. A assinatura é local ("ad hoc"): o app abre neste Mac,
mas em outro Mac o macOS o bloqueia até ser liberado manualmente, e as permissões
(Gravação de Tela, microfone, câmera) são pedidas de novo a cada nova versão.

```bash
npm run dist:check
```

Abre o app empacotado e confere o que só existe no pacote (helpers, FFmpeg, ícone).

Para distribuir a outras pessoas, `npm run dist:signed` assina com o certificado
"Developer ID Application" do Chaveiro (com hardened runtime); a notarização na
Apple ainda não está configurada.

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
