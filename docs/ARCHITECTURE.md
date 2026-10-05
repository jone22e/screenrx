# ScreenRx — Arquitetura

Gravador e editor de tela **não destrutivo** para desktop. macOS 14+ é a primeira
plataforma; a captura fica atrás de uma abstração para receber Windows depois.

Este documento descreve a arquitetura, os modelos, as interfaces entre módulos,
os riscos técnicos e o estado de cada fase.

## 1. Visão geral

```
Capture Engine → Recording Session → Media Assets → Project → Timeline → Preview Renderer → Export Renderer
```

Três processos, com responsabilidades separadas:

```
┌─ Renderer (React, sandbox) ─────────────┐
│  Janela principal        HUD            │   só UI; nenhum acesso a Node, disco ou FFmpeg
└──────────────▲──────────────────────────┘
               │ window.screenrx  (preload: uma função por canal)
┌──────────────┴─ Electron Main ──────────┐
│  RecordingController (máquina de estados)│   fonte da verdade do estado de gravação
│  SessionStore (sessões em disco)         │
│  WindowManager (janelas + CaptureShield) │
│  CaptureEngine (interface)               │
└──────────────▲──────────────────────────┘
               │ JSON-lines por stdin/stdout
┌──────────────┴─ screenrx-capture (Swift) ┐
│  ScreenCaptureKit → AVAssetWriter        │   dono do relógio de mídia
│  RecordingClock (host clock)             │
└──────────────────────────────────────────┘
```

Por que um helper nativo em processo separado: ScreenCaptureKit/AVFoundation não
são acessíveis de forma confiável a partir do Electron, o vídeo nunca passa pela
memória do JavaScript (requisito de gravações de 60 min+), e uma falha na captura
não derruba a interface.

## 2. Estrutura de pastas

```
native/macos/CaptureHelper/        Pacote Swift
  Sources/CaptureCore/             lógica pura e testável: RecordingClock, Telemetry,
                                   VideoGeometry, WireProtocol, CaptureDefaults, Deadline
  Sources/screenrx-capture/        executável: ScreenRecorder, CompanionTracks,
                                   MediaTrackWriter, Devices, PointerTelemetry,
                                   SessionClock, SourceCatalog, CommandServer…
  Sources/screenrx-transcribe/     executável separado: fala → palavras com tempo
                                   (SpeechAnalyzer, no próprio Mac)
  Tests/CaptureCoreTests/
src/
  shared/                          TypeScript puro, usado por main, preload e renderer
    models/                        capture, session, recording, permissions, errors, project,
                                   captions (transcrição), suggestions (propostas da IA),
                                   ai (ferramentas, modelos, esforço, escolha do usuário)
    ipc/contract.ts                contrato tipado de todos os canais IPC
    time/RecordingClock.ts         relógio lógico (espelho do relógio nativo)
    config/recording.ts            constantes da gravação
  engine/                          lógica pura de edição, usada por preview e export
    zoom/                          zoomConfig (constantes), zoomCamera (movimento),
                                   autoZoom (geração), zoomEditing (edição na timeline)
    rendering/                     backgrounds (catálogo de fundos), frameLayout
                                   (moldura e posição da câmera)
    time/timeMapping.ts            origem ↔ linha do tempo ↔ saída (cortes, velocidade)
    timeline/                      spanEditing (mover/redimensionar regiões), trimConfig
    export/                        exportPlan (tamanho, quadros), audioFilters
                                   (atempo, grafo de áudio), exportConfig
    captions/                      captionCues (palavras → legendas, legenda do instante),
                                   captionLayout (quebra de linha e posição), captionConfig
    suggestions/cutSuggestions.ts  pedido à IA (palavras numeradas) e validação da resposta
  main/
    capture/                       CaptureEngine (interface) + macos/ (cliente do helper)
    recording/                     RecordingController, SessionStore, diagnostics
    project/ProjectStore.ts        project.json: abertura, auto zoom inicial, salvamento
    captions/TranscriptionService  executa o transcritor, grava transcript.json
    ai/                            AiCliService (único lugar que pergunta algo a uma IA: CLI
                                   do Claude, do Codex ou do Antigravity), AiSetupService
                                   (situação, instalação e login das ferramentas), aiCatalog
                                   (modelos e esforços), CutSuggestionService
    export/                        FfmpegService (único lugar que executa FFmpeg),
                                   ExportService, leitura do avcC do MP4
    media/                         protocolo screenrx-media:// (streaming por faixas),
                                   ThumbnailService (capas), WaveformService (formas de onda)
    windows/                       WindowManager, HUD, menu de fontes
    ipc/registerIpc.ts             handlers, validação de argumentos e de remetente
    filesystem/                    safePaths, atomicWrite
    logging/logger.ts              logger estruturado por escopo
  preload/index.ts                 ponte explícita (contextBridge)
  renderer/
    index.html, hud.html           duas páginas, uma por janela
    src/app/                       janela principal: biblioteca de gravações
    src/camera/                    janela flutuante com a imagem da câmera
    src/editor/                    editor: EditorStore, PreviewPlayer, Timeline, Sidebar…
    src/rendering/composeFrame.ts  desenha um quadro final (fundo, zoom, câmera, legenda)
    src/export/                    renderExport (laço de quadros), TrackFrameReader
                                   (decodificação sequencial com WebCodecs)
    src/settings/                  tela de Configurações (ferramentas de IA)
    src/hud/                       HUD
    src/common/                    store de estado e estilos base
scripts/
  build-native.mjs                 compila os helpers e copia para dist-native/
  e2e-recording.mjs                validação de ponta a ponta com o app real
```

Ainda previsto: renderer de cursor e regiões de velocidade na interface.

## 3. Modelos principais

### Sessão de gravação (`src/shared/models/session.ts`)

Uma pasta por sessão em `~/Movies/ScreenRx/`:

```
recording-20261003-203556-847/
├── screen.mp4          trilha de tela
├── cursor.json         posição do cursor a 30 Hz
├── interactions.json   cliques
├── session.json        manifesto
├── project.json        edição (criado ao abrir no editor)
├── microphone.m4a      só quando o microfone está ligado
├── system.m4a          só quando o áudio do sistema está ligado
└── webcam.mp4          só quando a câmera está ligada
```

`session.json` (`RecordingSessionManifest`) registra fonte, parâmetros de captura,
duração segundo o relógio, pausas, as trilhas presentes e diagnósticos. É escrito
no início (`status: "recording"`) e finalizado uma única vez ao terminar. As
trilhas são **imutáveis**: o helper se recusa a escrever sobre um arquivo existente.

### Projeto (`src/shared/models/project.ts`)

- `TimelineEffect = ZoomEffect | SpeedEffect | TrimEffect` (união discriminada;
  annotation, blur, highlight e webcam entram depois). Todo efeito cobre um
  intervalo em **tempo de origem**, então uma edição nunca invalida as outras.
- `ExportSettings.speed` é a velocidade global de exportação. É um conceito
  separado de `SpeedEffect` desde o modelo.
- `CaptionSettings`: se as legendas aparecem, o tamanho do texto por legenda, o
  estilo (fonte, tamanho, cores, fundo do texto, posição) e as legendas em si
  (`CaptionCue`: intervalo em tempo de origem + texto). Ver "Legendas" na seção 6.
- Três espaços de tempo com tipos distintos: `SourceMs`, `TimelineMs`, `OutputMs`.
  As conversões (`sourceTimeToTimelineTime` etc.) serão o único lugar com
  aritmética de tempo.

### Estado efêmero × persistente

`RecordingStateSnapshot` (fase, fonte selecionada, tempo decorrido, último erro) é
estado de UI: vive no main, é transmitido às janelas e nunca vai para disco. O que
persiste é o manifesto da sessão e, futuramente, o projeto.

## 4. Interfaces entre módulos

| Fronteira | Contrato | Arquivo |
| --- | --- | --- |
| Renderer ↔ Main | `ScreenRxApi` / `IpcInvokeContract` / `IpcEventContract` | `src/shared/ipc/contract.ts` |
| Main ↔ captura | `CaptureEngine` (independente de plataforma) | `src/main/capture/CaptureEngine.ts` |
| Main ↔ helper macOS | protocolo JSON-lines versionado | `WireProtocol.swift` ↔ `helperProtocol.ts` |
| Controller ↔ janelas | `CaptureShield` (`engage` / `release`) | `src/main/recording/RecordingController.ts` |
| Controller ↔ disco | `SessionStore` | `src/main/recording/SessionStore.ts` |

`CaptureEngine` é o ponto de extensão para Windows: basta outra implementação
(Windows Graphics Capture + WASAPI); controller, sessões, HUD e editor não mudam.
`createCaptureEngine` é o único lugar que conhece a plataforma.

Protocolo do helper (uma mensagem JSON por linha):

```
→ {"id":"7","method":"recording.start","params":{…}}
← {"type":"response","id":"7","ok":true,"result":{…}}
← {"type":"event","name":"recording.interrupted","payload":{…}}
← {"type":"log","level":"info","scope":"capture","message":"…"}
```

Métodos: `hello`, `permissions.status`, `permissions.requestScreenRecording`,
`sources.list`, `recording.start|pause|resume|stop`. Fechar o stdin é o sinal de
encerramento: o helper finaliza a gravação em andamento antes de sair.

## 5. Tempo e sincronização

O **relógio de mídia** é o host clock (mach absolute time) dentro do helper. Tudo o
que for capturado — tela, e depois áudio, webcam e telemetria do cursor — é
carimbado com esse relógio e mapeado por um único `RecordingClock` (Swift) para
*tempo de gravação*: tempo desde o primeiro quadro, sem os trechos pausados.

- t=0 é o primeiro quadro completo entregue pelo ScreenCaptureKit.
- Pausar não para o stream; os quadros cujo carimbo cai dentro de uma pausa são
  descartados. O último quadro visto durante a pausa é gravado no instante da
  retomada, para o vídeo não mostrar conteúdo antigo se a tela ficar parada.
- O `RecordingClock` em TypeScript é o espelho usado para estado e HUD; a cada
  transição ele é realinhado (`alignTo`) ao tempo informado pelo helper.
- Ao terminar, a duração do relógio é comparada com a duração lida do arquivo.
  Diferença acima de `maxDurationDriftMs` vira diagnóstico `duration-drift` no
  manifesto e aviso no log — nunca é corrigida em silêncio.

### Trilhas complementares (microfone, áudio do sistema, webcam)

Cada trilha vai para o seu próprio arquivo; nada é mixado nem queimado na trilha
da tela, para o editor poder mover, silenciar ou remover cada uma depois.

- **Microfone e webcam**: `AVCaptureSession` no helper. Os carimbos de tempo saem
  no relógio da sessão de captura e são convertidos para o host clock.
- **Áudio do sistema**: vem do próprio stream do ScreenCaptureKit
  (`capturesAudio`), sem permissão adicional, e sem os sons do próprio app.
- Todas passam pelo `MediaTrackWriter`, que posiciona cada buffer no tempo de
  gravação dado pelo mesmo `SessionClock` da tela. O que foi carimbado antes do
  primeiro quadro, dentro de uma pausa ou depois do fim é descartado, então as
  trilhas já saem alinhadas. No áudio, um buffer que começaria antes do fim do
  anterior é encostado nele (nunca há sobreposição).
- Ligar um dispositivo pede a permissão naquele momento; se for negada, ele
  continua desligado e a gravação nunca começa com uma trilha que não pode ser
  capturada. Uma trilha que falha no meio custa só aquela trilha.
- Ao terminar, a duração de cada trilha é comparada com o relógio; diferença acima
  do limite, ou trilha pedida e não gravada, vira aviso no manifesto.

### Telemetria do cursor

O helper observa o ponteiro durante a gravação, separado dos quadros de vídeo:

- **Posição** a 30 Hz, por um timer de agenda absoluta (um tick atrasado não
  empurra os seguintes, então não há drift acumulado).
- **Cliques** em qualquer aplicativo, por um monitor global de eventos de mouse do
  AppKit — não exige permissão de Acessibilidade. Cliques sobre as janelas do
  próprio ScreenRx (o HUD) são descartados.

As observações ficam cruas, carimbadas com o host clock, e só no fim são mapeadas
pelo mesmo `RecordingClock` que retemporizou o vídeo. Por isso a pausa some da
telemetria exatamente como some do vídeo. Posições são normalizadas à área
capturada (0–1); valores fora desse intervalo indicam o cursor fora da gravação.

`cursor.json` é uma lista de `{timeMs, x, y}`; `interactions.json`, de
`{timeMs, type, x, y, button}` com `mouseDown`, `mouseUp` e o gesto concluído
(`click`, `doubleClick`, `rightClick`, `middleClick`).

## 6. Zoom

Um zoom é só uma descrição no projeto — intervalo, foco, escala — e nunca gera
vídeo novo. Tudo fica em `src/engine/zoom/`:

- **`zoomCamera.ts`** — `cameraAt(zooms, tempo)` devolve a câmera (escala e centro)
  de um instante. É a única fonte do movimento: o preview a usa hoje e o export
  usará a mesma função, então o que se vê é o que se exporta. A entrada e a saída
  têm easing cúbico; perto de uma borda o enquadramento é contido no quadro; dois
  zooms encostados fazem a câmera deslizar de um foco ao outro sem abrir.
- **`autoZoom.ts`** — `generateAutoZooms` agrupa cliques próximos no tempo e no
  espaço, aplica as margens e cria um zoom por grupo, centrado na média dos cliques.
  Usa apenas a telemetria; nenhum pixel é analisado.
- **`zoomEditing.ts`** — mover, redimensionar e inserir zooms na timeline, sem
  sobreposição e respeitando a duração mínima.
- **`zoomConfig.ts`** — todas as constantes (intervalo de agrupamento, margens,
  escala, durações de transição, limites).

Ao abrir uma gravação que ainda não tem `project.json`, o `ProjectStore` cria o
projeto já com os zooms automáticos. Depois disso a geração só roda de novo quando
o usuário pede ("Regenerar zooms automáticos"); zooms criados ou ajustados à mão
passam a ser `manual` e são preservados na regeneração.

### Editor

React cuida do estado; o `PreviewPlayer` cuida dos quadros. A cada quadro ele
chama `composeFrame`, que desenha no canvas, nesta ordem: o fundo, a gravação
(com a câmera de zoom do instante) dentro da moldura de cantos arredondados, e a
webcam em círculo por cima. O export usará a mesma função. O tempo é avisado por
callbacks — o cursor da timeline e o relógio são atualizados direto no DOM, sem
re-renderizar componentes a cada quadro.

A trilha da tela é o relógio mestre do preview; a webcam e os áudios são arquivos
separados que a seguem e são realinhados quando se afastam. Tudo chega pelo
protocolo `screenrx-media://`, servido pelo main em faixas direto do disco.

O projeto guarda também o enquadramento (`background`: fundo do catálogo, margem,
cantos, sombra) e como a webcam aparece (`webcam`: visível, formato círculo /
arredondada / quadrada, tamanho, canto ou posição livre, borda, espelhada). A
posição da webcam é calculada por `layoutWebcam`, usada pelo preview, pelo arrasto
no vídeo e pela exportação.

A linha do tempo mostra o próprio material: miniaturas do vídeo e da câmera
(`Filmstrip`, desenhadas buscando quadros em um elemento de vídeo descartável) e a
forma de onda de cada áudio (`Waveform`; os picos são calculados no main por um
FFmpeg em streaming e ficam só em memória). Arrastar sobre a trilha de vídeo marca
uma **seleção** — estado de interface, nunca salvo — que pode ser cortada; as
teclas I e O marcam início e fim na posição atual. O inspetor lateral tem uma aba
por aspecto da edição (cortes, zoom, fundo, câmera). O `EditorStore` mantém histórico para
desfazer/refazer — um arrasto ou um controle deslizante contam como um único
passo — e salva sozinho 400 ms após a última alteração (escrita atômica), e
também ao sair do editor. Seleção e demais estados de interface não são
persistidos.

### Legendas

```
trilha de áudio → screenrx-transcribe (SpeechAnalyzer, local) → transcript.json
                                                                     ↓ buildCues
                          project.json: captions.cues (editáveis) + estilo
                                                                     ↓ cueAt(tempo de origem)
                                  composeFrame → preview e exportação
```

- **Transcrição.** `screenrx-transcribe` é um executável à parte do helper de
  captura (uma transcrição nunca pode interferir em uma gravação). Recebe a
  trilha e o idioma, reconhece a fala no próprio Mac — o áudio não é enviado a
  lugar nenhum — e escreve em stdout, como linhas JSON, o estado e as palavras
  com início e fim em milissegundos. Cancelar é encerrar o processo. Requer
  macOS 26 (`SpeechAnalyzer`); em sistemas anteriores responde `unsupported-os`.
  Não pede permissão de reconhecimento de fala. O modelo do idioma é baixado
  pelo sistema no primeiro uso.
- **`TranscriptionService`** (main) executa o transcritor, uma transcrição por
  vez, limpa as palavras (`normalizeWords`) e grava `transcript.json` na sessão.
  É dado derivado: pode ser apagado e gerado de novo; a trilha só é lida.
- **Palavras → legendas** (`buildCues`): uma legenda termina quando enche (18, 42
  ou 84 caracteres), no fim de uma frase ou em uma pausa, e não fica na tela
  muito depois da última palavra. Trocar o tamanho refaz as legendas a partir da
  mesma transcrição.
- **As legendas pertencem ao projeto.** Depois de geradas são do usuário: texto
  corrigido no painel, tempo ajustado na linha do tempo, tudo com desfazer. Ficam
  em tempo de origem, então um corte simplesmente não mostra a legenda daquele
  trecho, e a velocidade de exportação não exige nenhum ajuste.
- **Desenho** (`layoutCaption` + `composeFrame`): tamanho da fonte e posição são
  proporções da saída, linhas equilibradas, bloco sempre dentro do quadro. A
  legenda é desenhada por cima do quadro pronto (não sofre zoom). Preview e
  exportação usam a mesma função. Só fontes do sistema, nada é embutido.
- **No preview** a legenda pode ser arrastada, como a câmera.

### Sugestões de corte por IA

```
transcript.json → buildCutPrompt (palavras numeradas + pausas)
        ↓ AiCliService: CLI do Claude, do Codex ou do Antigravity, uma pergunta, resposta em JSON
parseCutResponse → propostas (trecho, tipo, motivo, texto) → painel e linha do tempo
        ↓ o usuário aceita
corte comum (TrimEffect) no project.json, com desfazer
```

- **A IA só propõe.** A resposta vira uma lista de sugestões, que é estado de
  interface e nunca entra no projeto. Aceitar uma sugestão cria um corte comum;
  desfazer o corte traz a sugestão de volta; rejeitar a remove.
- **O que ela procura:** frases recomeçadas e o aviso do recomeço (`retake`),
  vícios de fala (`filler`) e trechos fora do assunto (`off-topic`). Pausas sem
  fala não são sugeridas: em uma gravação de tela o silêncio costuma ser alguém
  fazendo algo na tela, e isso a transcrição não mostra.
- **Índices de palavras, não tempos.** A IA responde com o intervalo de palavras
  a remover; o tempo vem da transcrição. O corte vai do início da primeira
  palavra ao início da palavra seguinte à última, então nenhuma palavra é
  cortada ao meio. A resposta não é confiável: intervalos inválidos ou
  sobrepostos são descartados.
- **`AiCliService`** usa as ferramentas que o usuário já tem instaladas e com
  login (`claude --print`, `codex exec`, `agy --print`); o app não guarda chave
  de API. As ferramentas rodam sem nada com que agir: sem ferramentas
  (`--tools ""`), em sandbox somente leitura ou em modo plano, sem persistir
  sessão, em um diretório temporário vazio, com limite de tempo. Variáveis de uma
  sessão do Claude Code em que o app tenha sido iniciado não são repassadas.
- **Ferramenta, modelo e esforço** são escolha do usuário (`AiChoice`), feita na
  tela de Configurações e guardada pela janela (`localStorage`), não no projeto.
  O id do modelo vai para uma linha de comando, então só identificadores simples
  são aceitos (`isAiModelId`); o esforço é mapeado para o nível mais próximo que
  cada ferramenta aceita (`toolEffort`).
- **`AiSetupService`** diz como cada ferramenta está neste Mac: instalada,
  versão, com login (e em qual conta), modelos e níveis de esforço. Os modelos do
  Claude são os apelidos do próprio CLI (seguem sempre a versão mais nova); os do
  Codex vêm do catálogo que ele guarda em `~/.codex/models_cache.json`; os do
  Antigravity, de `agy models`. Também instala (o instalador oficial de cada
  fornecedor, só depois de uma confirmação nativa) e inicia o login do Claude e
  do Codex (o próprio CLI abre o navegador; o fim é percebido consultando o
  status). O Antigravity não tem comando de login: entra na primeira execução no
  Terminal.
- **Privacidade:** só o texto da transcrição é enviado ao provedor da ferramenta
  escolhida, e só quando o usuário pede. Áudio, vídeo, caminhos e ids ficam no Mac.
- Transcrições muito longas são analisadas até 12 000 palavras, e o painel avisa.

### Janelas

O app tem dois modos, e só um está na tela por vez. Abre na **biblioteca**; "Nova
gravação" esconde a biblioteca e mostra a **barra de gravação**. Fechar a barra,
terminar uma gravação ou um erro ao prepará-la devolvem a biblioteca (com a
gravação nova aberta no editor, ou com o motivo do erro). O `WindowManager`
concentra essa troca (`openRecorder` / `showLibrary`).

- **Barra de gravação (HUD)** — o único lugar onde se escolhe o que gravar: fonte,
  microfone e câmera por menus nativos, e o som do computador por um interruptor
  próprio, ligado por padrão (o que o computador toca faz parte do que está na
  tela; quando vinha desligado e escondido no menu do microfone, gravações saíam
  mudas sem o usuário perceber). Só existe na tela
  enquanto o usuário está prestes a gravar ou gravando. No menu de fontes cada
  monitor aparece pelo nome que o sistema lhe dá (no idioma do usuário), com uma
  miniatura do que está nele, o tamanho em pontos, se é o principal ou onde fica
  em relação a ele ("acima da principal") e em qual está a barra — dois monitores
  do mesmo modelo têm nome e tamanho iguais, e é a posição e a miniatura que os
  distinguem. O nome do monitor é também o título da gravação.
- **Janela principal** — a biblioteca: uma grade de gravações agrupadas por dia,
  cada uma com capa, duração, trilhas presentes, tamanho e resolução; busca por
  nome; abrir no editor, mostrar no Finder e excluir. Excluir pede confirmação e
  move a pasta inteira da sessão para a Lixeira do sistema (nunca apaga em
  definitivo). As capas são geradas sob demanda pelo FFmpeg embutido e ficam em um
  cache fora das sessões.
- **Câmera** — com a barra aberta e uma câmera selecionada, uma janela circular flutuante mostra a
  imagem dela para o usuário se enquadrar antes e durante a gravação. É só um
  espelho: como toda janela do app, fica fora da captura, e a trilha da câmera é
  gravada à parte pelo helper.

## 7. Cortes, tempo e exportação

### Os três tempos

`src/engine/time/timeMapping.ts` é o único lugar que converte entre eles:

- **origem** — posição na gravação, como foi capturada (é onde os efeitos vivem);
- **linha do tempo** — a origem sem os cortes e com as regiões de velocidade;
- **saída** — a linha do tempo dividida pela velocidade global de exportação.

`buildTimeMap` transforma a duração e os efeitos em segmentos mantidos, cada um
com sua velocidade. As funções `sourceTimeToTimelineTime`,
`timelineTimeToSourceTime`, `outputTimeToTimelineTime` e companhia derivam tudo o
mais: o relógio do editor, o tempo de cada quadro exportado e os filtros de áudio.

### Cortes

Um corte é um `TrimEffect`: um intervalo da origem que sai do resultado. Nada é
removido da gravação. No preview a reprodução salta os cortes; a linha do tempo
continua desenhada no tempo de origem, com os trechos cortados escurecidos, e o
relógio mostra o tempo já editado. Um corte nunca pode deixar menos de
`minKeptDurationMs` de vídeo.

### Velocidade global × regiões de velocidade

São conceitos separados no modelo. `ExportSettings.speed` escala a linha do tempo
inteira no momento da exportação; `SpeedEffect` é uma edição criativa de um
trecho. O mapeamento de tempo e o grafo de áudio já tratam os dois (e os
multiplicam onde se sobrepõem); a interface ainda só oferece a velocidade global.

### Exportação

```
quadro de saída i → tempo de saída → linha do tempo (× velocidade) → origem (cortes)
        ↓
TrackFrameReader: decodifica a trilha em sequência (WebCodecs) e entrega o quadro daquele instante
        ↓
composeFrame + cameraAt (o mesmo código do preview)
        ↓  pixels RGBA, um quadro por vez, com contrapressão
FFmpeg: codifica H.264 uma única vez, processa o áudio, gera o MP4
```

- O renderer desenha cada quadro de saída diretamente no seu instante final. Uma
  exportação em 2× tem metade dos quadros; não existe render em 1× recodificado.
- A taxa de quadros é escolha do usuário (`ExportSettings.fps`: 24, 30 ou 60;
  padrão 30) e só muda quantos instantes são desenhados: o mesmo tempo de saída
  mostra o mesmo instante da gravação em qualquer taxa. A taxa de bits acompanha
  a de quadros, dentro dos limites. A tela é gravada a 60 fps, então 60 na saída
  não inventa quadros.
- O main descreve cada trilha de vídeo (tabela de quadros via FFprobe e a
  configuração do decodificador lida do MP4) e serve os bytes sob demanda. O
  `TrackFrameReader` mantém poucos quadros em memória e, depois de um corte longo,
  recomeça no quadro-chave mais próximo.
- O `ExportService` lê o projeto do disco, calcula o plano (`exportPlan`), abre o
  diálogo de salvar e inicia um único FFmpeg: `h264_videotoolbox` quando existe,
  `libx264` caso contrário, sempre `yuv420p`. O arquivo é escrito como `.part` e
  só recebe o nome final ao terminar; cancelar ou falhar remove o parcial.
- **Áudio**: cada trilha passa pelos mesmos segmentos do vídeo (`atrim`), tem o
  tempo ajustado por `buildAtempoFilter` — que preserva o tom e encadeia filtros
  quando a velocidade passa do limite de um só (4× → `atempo=2,atempo=2`) — e as
  trilhas são mixadas. Tudo no mesmo FFmpeg da codificação.
- **Legendas** são desenhadas em cada quadro pelo `composeFrame`, como no
  preview; não há trilha de legenda no arquivo nem filtro de texto no FFmpeg.
- O FFmpeg e o FFprobe vêm embutidos (`ffmpeg-static`, `@ffprobe-installer/ffprobe`, ambos nativos de Apple Silicon); o
  `FfmpegService` é o único código que os executa.

## 8. HUD fora da captura

Duas camadas, ativadas **antes** do primeiro quadro (`CaptureShield.engage()` é
chamado antes de `engine.start()`):

1. **Exclusão por aplicativo no ScreenCaptureKit** (mecanismo principal): o main
   envia seu PID; o helper localiza o `SCRunningApplication` correspondente e cria
   `SCContentFilter(display:excludingApplications:exceptingWindows:)`. Excluir o
   aplicativo, e não janelas, cobre também janelas abertas depois do início. O
   helper devolve os PIDs realmente excluídos; se o do app não estiver entre eles,
   a sessão recebe o diagnóstico `self-exclusion-missing`.
2. **`setContentProtection(true)`** nas janelas do app, que as esconde de
   screenshots e de outros gravadores enquanto a gravação está ativa.

Na captura de janela usa-se `SCContentFilter(desktopIndependentWindow:)`, que grava
só o conteúdo daquela janela, mesmo coberta por outras.

## 9. Segurança

- Renderers com `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- O preload expõe apenas `window.screenrx`, uma função por canal; `ipcRenderer`
  nunca é exposto.
- Todo handler valida o remetente (frame principal de uma janela do app, URL do
  app) e trata argumentos como `unknown`.
- O renderer nunca envia caminhos: envia ids (`recording-YYYYMMDD-HHMMSS-mmm`,
  `display:N`, `window:N`) validados por regex; os caminhos são resolvidos no main
  por `resolveInside`, que rejeita qualquer resultado fora da raiz.
- CSP injetada no build (`default-src 'none'`, scripts só do próprio app),
  navegação e `window.open` bloqueados, permissões web negadas.
- `session.json` é gravado de forma atômica (arquivo temporário → fsync → rename).

## 10. Falhas tratadas

| Situação | Comportamento |
| --- | --- |
| Permissão de Gravação de Tela ausente | Verificação sem prompt (`CGPreflightScreenCaptureAccess`); aviso na janela principal dizendo **qual aplicativo** precisa ser ativado nos Ajustes, com botões para solicitar e abrir os Ajustes. O prompt só aparece por ação do usuário. Verificações simultâneas compartilham uma única consulta ao helper. |
| Fonte deixou de existir | `source-unavailable`; a seleção é limpa. |
| Janela fechada / stream encerrado pelo sistema | O helper finaliza o arquivo com o que foi gravado e emite `recording.interrupted`; a sessão fica `completed` com diagnóstico `interrupted`. |
| Disco cheio / falha do encoder | Gravação encerrada, arquivo incompleto descartado, erro `disk-full` ou `capture-failed`. |
| Helper morre | Estado volta a `idle` com erro; janelas restauradas; sessão marcada `failed` (arquivo parcial preservado); o helper é recriado na próxima ação. |
| Arquivo vazio ou sem quadros | `recording-invalid`; a sessão vazia é removida. |
| App fechado durante a gravação | `before-quit` finaliza o arquivo antes de sair. |
| Microfone com taxa de amostragem fora do padrão (fone Bluetooth: 16 kHz) | A trilha é reamostrada para 48 kHz ao gravar (`AudioEncoding`). Antes disso o codificador AAC recusava a configuração e a trilha do microfone se perdia, com o diagnóstico `track-missing`. |
| Sessão `recording` encontrada ao iniciar | Marcada `failed` (o app caiu no meio). |
| Transcrição indisponível (macOS anterior ao 26, idioma sem suporte, transcritor ausente) | `transcription-unavailable`, explicado no painel de legendas; o resto do editor funciona. |
| Instalação ou login de uma ferramenta de IA não conclui | `ai-install-failed` / `ai-login-failed`, com a última linha que a ferramenta escreveu no log; o cartão da ferramenta mostra o aviso e a situação é lida de novo. |
| CLI de IA ausente, sem login, sem resposta em 5 min ou com resposta inválida | `ai-unavailable` / `ai-failed`, explicado no painel; nenhuma sugestão é criada e nada é cortado. |
| Transcrição falha, é cancelada ou não encontra fala | Nada é gravado em caso de falha ou cancelamento; sem fala, o painel avisa e o projeto fica sem legendas. Sair do editor cancela a transcrição em andamento. |
| Chamadas do ScreenCaptureKit que não retornam | Limite de tempo em `stopCapture`; o início usa o primeiro quadro como sinal de sucesso, com timeout. |

## 11. Riscos técnicos

1. **Um único cliente de captura por executável.** Verificado em teste: quando um
   segundo processo do mesmo executável usa o ScreenCaptureKit (ou encerra), o
   macOS derruba o stream do outro (`SCStreamError -3805`). Regra: existe um só
   helper, e ele nunca é recriado durante uma gravação. O teste de ponta a ponta
   roda uma cópia própria do helper para conviver com um app de desenvolvimento
   aberto. Embutir um `Info.plist` com bundle id no helper causa o mesmo erro, por
   isso ele não tem um.
2. **Atribuição de permissão (TCC).** O macOS atribui a permissão ao processo
   *responsável* pelo helper: empacotado, é o próprio ScreenRx; em desenvolvimento,
   é o aplicativo que executou o `npm run dev` (Terminal, VS Code, Claude…), e é
   esse nome que aparece nos Ajustes. O helper informa quem é o responsável e o
   aviso de permissão mostra o nome. Assinatura e bundle id estáveis são
   pré-requisito para a permissão persistir entre versões. Empacotamento
   (electron-builder, assinatura, notarização) ainda não existe.
3. **Proteção de conteúdo varia entre versões do macOS.** Por isso a exclusão no
   filtro do ScreenCaptureKit é o mecanismo principal. Ambas as camadas foram
   verificadas no macOS 26.2; macOS 14 e 15 não foram testados.
4. **Limite do H.264 (4096×2304).** Telas 5K/6K são reduzidas para caber. HEVC como
   codec da trilha mestre é a alternativa se a perda for relevante.
5. **MP4 não é resistente a quedas.** O índice é escrito no final: `kill -9` ou
   falta de energia deixam o arquivo ilegível. Encerramentos normais (stdin
   fechado, SIGTERM, saída do app) finalizam o arquivo. Gravação fragmentada é a
   evolução possível.
6. **Taxa de quadros variável.** O ScreenCaptureKit só entrega quadros quando a
   tela muda; preview e export devem trabalhar por timestamp, não por índice.
7. **Cursor ainda queimado no vídeo** (`RECORDING_CONFIG.showCursor`). A telemetria
   já existe; falta o renderer de cursor no editor para poder gravar sem ele.
8. **Telemetria na captura de janela** é normalizada pela posição da janela no
   início da gravação; se a janela for movida, os focos ficam deslocados.
9. **Pausa no áudio tem precisão de buffer, não de amostra.** Buffers inteiros são
   descartados na pausa, então cada pausa pode deslocar o áudio em alguns
   milissegundos em relação à tela.
10. **Throughput da exportação.** Cada quadro cruza renderer → main → FFmpeg como
    RGBA cru (17 MB em 2560 px de largura). Medido: tempo real nessa resolução a
    30 fps. Codificar no renderer (WebCodecs) e só muxar no FFmpeg seria mais
    rápido, se isso virar gargalo.
11. **Licença do FFmpeg embutido.** `ffmpeg-static` distribui um build GPL (inclui
    `libx264`). O app só o executa como processo separado, mas distribuir o binário
    obriga a cumprir a GPL para ele. Trocar por um build LGPL (sem `libx264`,
    mantendo `h264_videotoolbox`) elimina a questão e é só mudar o caminho no
    `FfmpegService`. No app empacotado os binários precisam ficar fora do `asar`.
12. **Não verificado nesta fase:** múltiplos monitores, HUD sobre apps em tela
    cheia, disco realmente cheio, gravações de 30–60 min, fechamento da janela
    gravada no meio da gravação e o clique em "Solicitar permissão" (o estado de
    permissão negada e o aviso foram verificados; o prompt do sistema não foi
    acionado nos testes).

## 12. Fases

| Fase | Escopo | Estado |
| --- | --- | --- |
| 1 | Electron, janela principal, HUD, seleção de fonte, ScreenCaptureKit, iniciar/pausar/retomar/parar, MP4 válido, HUD fora da captura | **concluída** |
| 2 | Microfone, áudio do sistema, webcam, sincronização | **concluída** (webcam sem verificação real, ver abaixo) |
| 3 | Telemetria do cursor e de cliques (`cursor.json`, `interactions.json`) | **concluída** |
| 4 | Editor, preview, timeline, zoom manual | **concluída** |
| 5 | Auto zoom | **concluída** |
| 6 | Trim, regiões de velocidade | cortes **concluídos**; regiões de velocidade só no motor (sem interface) |
| 7 | Exportação MP4 (FfmpegService) | **concluída** |
| 8 | Velocidade global de exportação com pitch preservado | **concluída** |
| 9 | Refinamento visual, otimização, Windows | pendente |
| — | Instalador para macOS (`npm run dist`): `.dmg` para Apple Silicon, assinatura local | **concluído**; assinatura Developer ID disponível (`dist:signed`), notarização não configurada |
| — | Legendas automáticas (pedido posterior à especificação): transcrição local, estilo, posição, edição do texto, exportação | **concluída** (só macOS 26+) |
| — | Sugestões de corte por IA (CLI do Claude, do Codex ou do Antigravity) a partir da transcrição | **concluída** (depende da transcrição: macOS 26+) |
| — | Configurações: instalar e entrar nas ferramentas de IA, escolher modelo e esforço | **concluída** (instalar e entrar sem verificação real) |

Ao fim de cada fase: compilar, typecheck, testes, validar o fluxo e atualizar este
documento antes de avançar.

### Empacotamento

`electron-builder.yml` monta o app a partir de `out/`: os helpers nativos vão para
`Contents/Resources/native` (onde o main os procura quando empacotado) e os
pacotes que carregam executáveis (`ffmpeg-static`, `@ffprobe-installer`) ficam
fora do `asar`. Todos os executáveis embutidos são nativos de Apple Silicon — o
`ffprobe-static` usado antes entregava um binário Intel na pasta "arm64", que só
rodava com o Rosetta instalado, e por isso foi trocado. O `Info.plist` declara os
textos de uso de microfone, câmera, áudio do sistema e reconhecimento de fala; os
entitlements (JIT do Electron, microfone, câmera) valem para a assinatura com
hardened runtime. Só Apple Silicon por enquanto (os helpers e o FFmpeg são
compilados/baixados para a arquitetura da máquina que gera o pacote).

`npm run dist:check` abre o app empacotado com um perfil descartável e confere
assinatura, arquitetura dos executáveis, FFmpeg/FFprobe fora do arquivo, helper de
captura, transcritor, ferramentas de IA e a extração de uma capa. **Não
verificado:** abrir o app pelo Finder depois de instalado (é aí que o macOS pede
a permissão de Gravação de Tela em nome do "ScreenRx"; no teste o app é iniciado
pelo terminal e herda a permissão dele), a build assinada com Developer ID e a
instalação em outro Mac.

### O que foi validado

`npm run test:e2e` conduz o app real e verifica 75 pontos, entre eles:

- o app sobe com as duas janelas, renderer isolado e só a ponte explícita;
- gravar → pausar → retomar → finalizar gera `screen.mp4` (H.264, yuv420p) e
  `session.json` coerentes; os 2 s pausados não entram no vídeo;
- o HUD continua visível e no topo durante a gravação, e **não aparece** no vídeo,
  nem no primeiro quadro — comparado com um controle em que o HUD é visível a um
  screenshot comum; durante a gravação ele também some dos screenshots do sistema.

- `cursor.json` sai a ~30 Hz no relógio da gravação, sem buraco na pausa;
- a gravação finalizada abre no editor; um zoom manual é salvo em `project.json`,
  aparece no preview e some ao ser removido, sem tocar no vídeo gravado.

- microfone e áudio do sistema saem em arquivos separados, com a mesma duração da
  tela mesmo com pausa no meio;
- a exportação gera MP4 H.264 `yuv420p` com o áudio mixado e a duração da edição;
  o quadro exportado bate com o preview do mesmo instante; com um corte e 2×, a
  duração é (gravação − corte) ÷ 2, com o áudio acompanhando; cancelar não deixa
  arquivo; o arquivo sai a 30 fps por padrão e a 60 fps quando escolhido (taxa e
  número de quadros conferidos no arquivo).

- legendas: em uma cópia da gravação com uma trilha de fala sintetizada (`say`), a
  fala é transcrita com as palavras certas e em ordem, as legendas vão para o
  `project.json`, aparecem no preview, mudam com o tamanho, o estilo e a posição,
  podem ser arrastadas e corrigidas, e saem no vídeo exportado como no preview.

- sugestões da IA: com uma CLI substituta (o teste não gasta cota de ninguém), a
  resposta vira proposta no painel e na linha do tempo sem cortar nada; a
  ferramenta recebe só as palavras numeradas; aceitar cria um corte nos limites
  das palavras; desfazer devolve a sugestão; rejeitar a remove;
- configurações: a tela abre pela biblioteca e pelo editor, mostra cada
  ferramenta como está (pronta, sem login, não instalada), e o modelo e o esforço
  escolhidos são os que a ferramenta recebe.

As CLIs reais foram verificadas à parte (`SCREENRX_AI_LIVE=1 npx vitest run
src/main/ai`): Claude, Codex e Antigravity acharam o começo abandonado de uma fala
de exemplo e preservaram a retomada, e a situação das três (versão, login,
modelos) foi lida corretamente. A qualidade das sugestões em uma narração real
não foi medida. **Instalar e entrar nunca foram executados de verdade** (as três
ferramentas já estavam instaladas e com login na máquina de desenvolvimento, e
sair de uma conta para testar não é aceitável): esses dois caminhos só têm testes
com ferramentas substitutas.

A transcrição foi verificada com voz sintetizada em português; a qualidade com
fala real (sotaque, ruído, termos técnicos) não foi medida.

O tom da voz preservado em 2× não é verificado automaticamente (o teste confere a
duração do áudio, não o tom); a escolha do filtro `atempo` é coberta por testes
unitários.

**Webcam:** o teste automatizado nunca grava a câmera (não dispara o prompt de
permissão). A captura foi confirmada em uma gravação real do usuário; formato,
posição, arrasto e exportação da câmera foram verificados com uma trilha de
câmera substituta em uma sessão gravada.

Também verificados manualmente: helper morto no meio da gravação, app fechado
durante a gravação, captura de janela, modo de desenvolvimento e a captura de um
clique real (o teste automatizado não gera cliques do sistema, então o caminho
clique → zoom automático é coberto por testes unitários, não de ponta a ponta).
