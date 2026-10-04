# ScreenRx

Gravador e editor de tela não destrutivo para desktop (macOS 14+).

Arquitetura, modelos, riscos e estado das fases: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requisitos

- macOS 14 ou superior, Xcode (toolchain Swift)
- Node.js 22.12+

## Desenvolvimento

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` compila o helper nativo de captura e abre o app com hot reload.

O macOS exige a permissão de Gravação de Tela. Em desenvolvimento ela não aparece
como "ScreenRx": pertence ao aplicativo que executou o `npm run dev` (Terminal,
VS Code, Claude…). A janela principal mostra qual é; ative-o em Ajustes do Sistema ›
Privacidade e Segurança › Gravação do Áudio do Sistema e da Tela.

As gravações ficam em `~/Movies/ScreenRx/`, uma pasta por sessão. Os logs ficam em
`~/Library/Logs/ScreenRx/main.log`.

## Verificação

| Comando | O que faz |
| --- | --- |
| `npm run typecheck` | TypeScript (main, preload, renderer) |
| `npm run lint` | ESLint |
| `npm test` | Testes unitários (Vitest) |
| `npm run test:native` | Testes do helper Swift |
| `npm run check` | Todos os anteriores |
| `npm run build` | Build de produção em `out/` |
| `npm run test:e2e` | Fluxo real de gravação, edição e exportação, após `npm run build`. Grava a tela por alguns segundos em uma pasta temporária; requer `ffmpeg`/`ffprobe` no PATH. |
