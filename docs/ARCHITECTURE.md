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
native/macos/VoiceHelper/          Pacote Swift à parte: dublagem com voz clonada
  Sources/VoiceCore/               lógica pura e testável: formato compacto dos pesos,
                                   regra de encaixe no tempo
  Sources/screenrx-dub/            executável: baixa e prepara o modelo de voz, sintetiza
  patches/                         alterações do projeto ao runtime de voz
  Vendor/                          runtime de voz (mlx-audio-swift), baixado na compilação
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
    dub/                           spellNumbers (números por extenso no idioma da dublagem),
                                   dubUnits (legendas → trechos de fala, referência de voz,
                                   posição dos trechos), dubVerification, dubConfig
    captions/                      textOverlays (textos do instante), captionCues (palavras → legendas, legenda do instante),
                                   captionLayout (quebra de linha e posição), captionConfig
    suggestions/cutSuggestions.ts  pedido à IA (palavras numeradas) e validação da resposta
    assistant/assistantPrompt.ts   chat de edição: prompt (estado + transcrição + conversa) e validação das ações
  main/
    capture/                       CaptureEngine (interface) + macos/ (cliente do helper)
    recording/                     RecordingController, SessionStore, diagnostics
    project/ProjectStore.ts        project.json: abertura, auto zoom inicial, salvamento
  library/VideoImporter.ts       traz um vídeo gravado fora do app para a biblioteca
  update/UpdateService.ts        atualização automática: consulta, baixa e instala (electron-updater)
    captions/DictationService      ditado do assistente: WAV → texto pelo transcritor nativo
  captions/TranscriptionService  executa o transcritor, grava transcript.json
    dub/DubbingService             executa o helper de voz, confere os trechos e monta a trilha
    ai/                            AiCliService (único lugar que pergunta algo a uma IA: CLI
                                   do Claude, do Codex ou do Antigravity), AiSetupService
                                   (situação, instalação e login das ferramentas), aiCatalog
                                   (modelos e esforços), CutSuggestionService
    export/                        FfmpegService (único lugar que executa FFmpeg),
                                   ExportService, leitura do avcC do MP4
    media/                         protocolo screenrx-media:// (streaming por faixas),
                                   ThumbnailService (capas), WaveformService (formas de onda)
    windows/                       WindowManager, HUD, menu de fontes, ícone da barra de
                                   menus (tray.ts; a imagem vem de scripts/make-tray-icon.py)
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
  build-voice.mjs                  compila o helper de voz (à parte: leva minutos)
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
no início (`status: "recording"`) e finalizado uma única vez ao terminar; depois
disso só muda quando a gravação é renomeada na biblioteca (campo opcional `title`,
que substitui o rótulo da fonte na lista, no editor e no nome sugerido da
exportação). As trilhas são **imutáveis**: o helper se recusa a escrever sobre um
arquivo existente.

Uma sessão também pode nascer de um **vídeo gravado fora do app** ("Importar vídeo"
na biblioteca, `VideoImporter`). O arquivo original não é tocado: a primeira trilha
de vídeo dele vira `screen.mp4` (copiada quando já é H.264 8 bits 4:2:0, o que o
editor e a exportação leem; re-codificada pelo FFmpeg embutido caso contrário) e a
primeira trilha de áudio, se houver, vira `microphone.m4a` (a trilha de onde legendas
e dublagem partem). A fonte fica `kind: "file"` com o nome do arquivo como rótulo,
não há `cursor.json` nem `interactions.json` (diagnóstico `telemetry-missing` de
nível info: sem zoom automático), e o manifesto é escrito com o que o FFprobe lê de
volta dos arquivos gerados. Se a importação falha no meio, a pasta da sessão é
removida inteira.

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
separados que a seguem. Um desvio de até 0,3 s é deixado como está
(`correctTrack`, em `engine/time/trackSync.ts`); só um acima disso vira seek. Dobrar o
`playbackRate` para alcançar a tela foi tentado e removido: o navegador estica o som
e isso se ouve como uma interferência no preview (a exportação não tem o problema),
e o áudio fica sempre uns 200 ms atrás da imagem depois de iniciar ou de um seek,
então a correção ficava perseguindo esse atraso fixo, trocando a velocidade umas duas
vezes por segundo. Um seek também é ouvido como um corte, por isso é raro. Faixas
ainda carregando ou no meio de um seek não são medidas. Tudo chega pelo protocolo `screenrx-media://`, servido pelo main em
faixas direto do disco.

O projeto guarda também o enquadramento (`background`: formato do vídeo, fundo do
catálogo, margem, cantos, sombra) e como a webcam aparece (`webcam`: visível, formato círculo /
arredondada / quadrada, tamanho, canto ou posição livre, borda, espelhada). A
posição da webcam é calculada por `layoutWebcam`, usada pelo preview, pelo arrasto
no vídeo e pela exportação.

**Formato do vídeo** (`background.aspect`, ferramenta Formato da trilha, com os logotipos):
nativo, Reels ou TikTok (os dois são 9:16; o nome escolhido fica guardado).
`outputSizeFor` dá o tamanho da saída: o da gravação no nativo; na vertical, uma
caixa 9:16 cujo lado menor é o lado menor da gravação (1920×1080 → 1080×1920).
Na vertical há dois enquadramentos (`background.fit`): **reduzir** (`fit`): a
gravação inteira, menor, centrada sobre o fundo (barras pretas sem fundo); **zoom**
(`fill`): a gravação ampliada até preencher o quadro, mostrando só uma parte dela
— a maior região da forma do quadro, centrada em `background.crop` (`sourceCrop`),
que o usuário escolhe arrastando o vídeo no preview (sem zoom selecionado). O zoom
da câmera continua em coordenadas da gravação inteira (os zooms automáticos
valem): `cameraWithin` leva a câmera para dentro da parte usada e a mantém contida;
`frameToSource` faz o caminho inverso no clique de foco. O preview redimensiona o
canvas ao trocar o formato; a exportação limita o lado maior (não a largura) à
qualidade escolhida, e o diálogo mostra a resolução final. Projetos antigos sem os
campos abrem como nativo. O assistente troca o formato ("format") e o
enquadramento ("framing"). **Não verificado:** nenhuma exportação real fora do
nativo; o arrasto da parte usada só por leitura do código.

O editor se organiza como os editores de vídeo, numa grade (`.editor`): uma
trilha de ícones na borda esquerda, da barra de ferramentas até o fim da janela
(`Sidebar`: Assistente, Cortes, Zoom, Legendas, Texto, Dublagem, Formato, Fundo e,
quando há, Câmera), o painel da ferramenta escolhida ao lado, também na altura toda, e à
direita o preview com a linha do tempo embaixo dele. Selecionar uma região na linha do tempo abre a
ferramenta dela.

A linha do tempo (`Timeline`) tem uma barra de ferramentas: **Remover** (a região
selecionada), **Encaixar** (ao arrastar ou redimensionar, uma borda a até 8 px de
um corte, de outra região, do cursor ou das pontas gruda nela; lembrado em
`localStorage`), o relógio "atual / total" e o zoom horizontal (1× a 8×: as pistas
se esticam dentro de um contêiner com rolagem, e durante a reprodução a rolagem
segue o cursor; o botão de ajustar volta a 1×). Os rótulos mostram "N trilhas", e
Cortes, Zoom e Texto têm um cadeado que trava a pista (estado só de interface: as
regiões dela param de reagir). O vídeo mostra, em cada trecho mantido, o nome da
gravação e a duração; as pistas de áudio, o nome da trilha (e "· mudo"); cada corte
é uma coluna escura hachurada com bordas vermelhas em todas as pistas e um selo
"✂ 1,6 s" no bloco; os zooms são trapézios. Além disso traz: um balão com o tempo em cima
do cursor; um "+" ao passar o mouse nos rótulos Cortes, Zoom e Texto, que cria a
região na posição do play; os rótulos Legendas e Câmera são interruptores de
visibilidade (olho); a pista Texto existe sempre (duplo clique adiciona); blocos de
legenda e de texto têm um ícone antes do texto; e a região selecionada ganha
alças brancas mais fortes e uma lixeira, quando é larga o bastante (64 px).

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
- **Idioma.** As legendas guardam o texto falado; `captions.translations` guarda,
  por idioma (inglês, espanhol, chinês, português) e por id de legenda, o texto
  traduzido, e `captions.language` diz qual é mostrado (`null`: o original). A
  tradução é pedida à ferramenta de IA escolhida nas Configurações
  (`CaptionTranslationService`: legendas numeradas, em lotes de 150, resposta
  validada; uma legenda sem tradução mostra o original). Trocar de idioma depois
  de traduzido é instantâneo; o texto traduzido é corrigido na mesma lista.
  Refazer as legendas (novo tamanho, nova transcrição) descarta as traduções,
  porque os ids mudam. Idiomas sem espaços quebram linha entre caracteres
  (`captionPieces`), com a pontuação de fechamento presa ao caractere anterior.

### Textos sobre o vídeo

Títulos e avisos escritos pelo usuário (`project.texts`, `TextOverlay`: intervalo
de origem, texto e um `CaptionStyle` próprio — fonte, tamanho, negrito, maiúsculas,
cor, fundo, posição). Podem se sobrepor no tempo. Aba **Texto** do editor
(`TextPanel`): "Adicionar texto" cria um na posição do play, com 3 s, "Seu texto",
grande e com sombra no meio do quadro; o selecionado tem caixa de texto e os
mesmos controles de estilo das legendas. No preview, o texto selecionado ganha uma
moldura tracejada com uma alça quadrada em cada canto, desenhada pelo
`PreviewPlayer` depois do `composeFrame` (só no preview; a exportação não passa por
ali); arrastar uma alça muda o tamanho da fonte na proporção da distância ao centro
do texto (`text-resize`, um passo de desfazer por arrasto). Arrastar um texto o posiciona
(o desenhado por último fica por cima e é o que o clique pega); na linha do tempo
há uma pista "Texto" com blocos que se movem e se redimensionam (mínimo 0,3 s).
Backspace remove o selecionado. O desenho reaproveita `drawCaption`
(`composeFrame`, campo `texts`), depois da legenda, no preview e na exportação
(`textsAt`). O assistente também escreve textos ("text"). **Não verificado:** só
por testes e leitura; nenhum arrasto nem exportação real com textos.

### Dublagem com a voz de quem gravou

```
legendas traduzidas → buildDubUnits (frases) ─┐
microfone + transcrição → pickVoiceReference ─┤
                                              ↓
        screenrx-dub (OmniVoice em MLX, no próprio Mac): um WAV por frase
                                              ↓ transcritor: o que se entende de cada um?
                       trechos mal entendidos são falados de novo (até 3 tomadas)
                                              ↓ layoutDubClips + FFmpeg
                    dub-<idioma>.m4a na sessão → preview e exportação
```

- **Separada das legendas.** Dublagem e legenda são coisas distintas na interface:
  a dublagem tem a própria aba no editor (`DubbingPanel`), e dublar não muda o que
  as legendas mostram (`captions.language`, visibilidade). O que elas compartilham
  é o texto: a dublagem parte das legendas geradas e da tradução guardada em
  `captions.translations`. "Dublar em X" (`EditorStore.dubInto`) traduz sozinho
  quando ainda não há tradução para X, sem trocar o idioma da legenda, e em
  seguida gera a voz. Dá para ter legenda sem dublagem, dublagem com legenda
  oculta, ou legenda em um idioma e voz em outro.
- **O que é.** O texto traduzido, falado no idioma dele com o timbre de quem
  gravou. A voz é clonada de 3 a 6,5 s do microfone (com o texto correspondente,
  que a transcrição já tem) e sintetizada **neste Mac**; nada é enviado. O
  resultado é mais uma trilha da sessão, derivada: pode ser gerada de novo, e as
  trilhas gravadas só são lidas. `project.dub.language` diz qual dublagem toca;
  em uso, ela toma o lugar do microfone no preview e na exportação.
- **Modelo e runtime.** OmniVoice (Apache 2.0, mais de 600 idiomas) na conversão
  compacta `mlx-community/OmniVoice-4bit`, executado por `mlx-audio-swift` (MIT)
  sobre MLX — Swift nativo, na GPU do Mac, sem Python. O modelo (1,14 GB) **não
  vem no instalador**: é baixado por dentro do app, uma vez, só quando o usuário
  pede (Configurações › Dublagem, ou a aba Dublagem do editor), para
  `userData/voice-models`. Só Apple Silicon.
- **`screenrx-dub`** (`native/macos/VoiceHelper`): `prepare` baixa o modelo e o
  desempacota; `synthesize` carrega o modelo uma vez e fala cada trecho. Fala por
  linhas JSON em stdout, como o transcritor; cancelar é encerrar o processo.
  Três coisas que o runtime não faz sozinho e o helper resolve:
  - *Formato compacto.* A conversão de 4 bits usa um formato próprio
    ("omnivoice-rowwise": grupos de 64 valores, um fator por grupo, dois valores
    por byte) que o runtime não lê. O helper o converte uma vez para o formato
    comum, no disco (`RowwiseWeights` é a especificação testada).
  - *Onde procurar o modelo.* O runtime ignora o cache que recebe e usa o do
    ambiente; o helper aponta esse ambiente para a pasta do app, então nada é
    lido nem gravado no cache pessoal do usuário.
  - *Biblioteca de shaders.* O MLX carrega `mlx.metallib` de ao lado do
    executável, e a compilação por linha de comando não a gera.
    `scripts/build-voice.mjs` a compila com o Metal Toolchain do Xcode quando ele
    está instalado, ou a extrai da distribuição do MLX da própria Apple, na mesma
    versão.
- **Runtime fixado e com patch.** O `mlx-audio-swift` é baixado em uma revisão
  fixa para `Vendor/` (fora do repositório) e recebe os patches de `patches/`;
  as versões de MLX que essa revisão usa também são fixadas. O patch atual iguala
  a junção de textos à do modelo original: sem espaço entre o texto da referência
  e um texto em chinês — com o espaço, as primeiras sílabas saíam trocadas.
- **Trechos de fala** (`buildDubUnits`): legendas são cortadas para leitura; uma
  voz precisa de frases. Legendas seguidas são unidas até o fim da frase, uma
  pausa ou 12 s. Cada trecho começa quando a primeira legenda dele começa.
- **Encaixe no tempo.** Cada trecho tem até o início do seguinte. O que passa
  disso é falado de novo com a duração pedida ao modelo (`DubTiming`), no máximo
  1,35× mais rápido; se ainda assim invadir o seguinte, o seguinte espera
  (`layoutDubClips`) — dois trechos nunca tocam ao mesmo tempo, e a pausa
  seguinte absorve o atraso.
- **Painel** (`DubbingPanel`): "Em uso: X" no cabeçalho; a linha "Falado em …"
  com Alterar (vai à aba Legendas); um cartão por voz — Original e cada dublagem
  gerada, como opções de rádio, com ⟳ para gerar de novo; a dublagem em andamento é
  um cartão tracejado com os três passos (Transcrever · Traduzir · Gerar voz) e
  Cancelar; "+ Adicionar idioma" abre a lista dos idiomas ainda sem dublagem; e,
  quando a dublagem em uso não é o idioma das legendas visíveis, um aviso "As
  legendas ainda estão em …" com "Usar <idioma>" (troca a legenda; traduz se preciso).
- **Sem legendas ainda.** "Dublar em X" numa gravação não transcrita primeiro
  descobre o idioma falado e transcreve nele, depois dubla (progresso e cancelar na
  própria aba Dublagem). A detecção (`captions:detect-locale`,
  `TranscriptionService.detectLocale`): o FFmpeg corta os primeiros 20 s da trilha
  em WAV 16 kHz; o `screenrx-transcribe --detect --locales …` transcreve o trecho
  em cada idioma da lista do app **cujo modelo já está baixado neste Mac** (baixar
  todos levaria muito) e dá nota a cada texto com o reconhecedor de idioma do
  sistema (`NLLanguageRecognizer`: quanto o texto parece ser daquele idioma, vezes
  um fator que só é cheio a partir de 12 palavras); vence a maior nota; sem nenhum
  candidato pontuado, fica o padrão pt-BR. A aba Legendas tem "Detectar" ao lado do
  idioma, com o resultado e quantos idiomas foram tentados. Uma gravação sem áudio
  não oferece dublagem. Quais modelos estão baixados vem de
  `SpeechTranscriber.installedLocales` — `AssetInventory.status` responde
  `supported` até para um modelo já instalado, por isso o `transcribe` normal
  anuncia "downloading" mesmo quando não baixa nada. **Verificado uma vez** num
  trecho de 20 s de uma gravação em português do Mac do Jone (pt-BR, en-US, es-ES
  e zh-CN instalados): pt-BR 0,99998 com 70 palavras, es-ES 0,95, inglês e chinês
  0; 5,9 s no total. O espanhol perto do português é o caso a vigiar: um clipe
  curto ou mal falado pode pender para ele.
- **Números por extenso.** O modelo lê algarismos no idioma de quem gravou:
  "300:5" numa dublagem em inglês saía em português. Antes de sintetizar, o texto de
  cada trecho passa por `spellNumbers` (`engine/dub/spellNumbers.ts`), que escreve
  inteiros, decimais, porcentagens e razões ("300:5" → "three hundred to five") em
  inglês, espanhol, português ou chinês; as legendas continuam com os algarismos.
  A conferência compara os dois lados por extenso, porque o transcritor devolve
  dígitos. Não testado de ouvido.
- **Conferência.** Clonar voz entre idiomas erra às vezes (uma palavra engolida,
  um trecho ininteligível). Cada trecho gerado é ouvido pelo transcritor no idioma
  de destino e comparado com o texto (`speechSimilarity`); abaixo de 80% de
  acerto, é falado de novo com outra semente, até três tomadas, e fica a melhor.
- **Montagem.** O `FfmpegService` posiciona os trechos em uma trilha do tamanho da
  gravação (`mixClips`, em grupos de 48 entradas) e grava AAC; o arquivo é escrito
  como `.part` e renomeado ao terminar.

### Assistente de edição (chat)

O painel abre no modo **Simples**: cartões com o que o assistente vê para fazer
nesta gravação, calculados dela mesma, sem chamar IA (`AssistantSuggestions`,
`engine/assistant/quickFixes.ts`): remover pausas longas (silêncios de mais de
1,5 s entre palavras da transcrição, cortados com 200 ms de margem, num passo só
de desfazer), zoom automático nos cliques (`regenerateAutoZooms`), gerar legendas
(pt-BR, trilha do microfone) e limpar a fala com IA (as sugestões de corte). Cada
cartão tem **Aplicar** e passa a "Aplicado ✓" quando a condição já está atendida.
O modo **Avançado** é a conversa; enviar uma mensagem muda para ele.


```
mensagem + estado da edição + conversa (renderer)  →  ai:assist
        ↓ AssistantService: lê transcript.json, buildAssistantPrompt
        ↓ AiCliService (a mesma ferramenta de "Sugerir cortes"), resposta em JSON
parseAssistantResponse → { text, actions[] } já em ms e validadas
        ↓ applyAssistantActions (renderer): um passo de desfazer por mensagem
cortes, zooms, velocidade, legendas, fundo, câmera, mudo no project.json
```

Uma das ferramentas da trilha de ícones do editor (`AssistantPanel`, aberta pelo
primeiro item, "Assistente"; o painel fica montado mesmo com outra ferramenta
escolhida, para a conversa e uma resposta a caminho não se perderem). Dá para ditar a mensagem: o botão
de microfone grava pelo `MediaRecorder` do renderer (um clique começa, outro
termina; o × descarta; no máximo 10 min), o áudio vira WAV mono de 16 kHz no
próprio renderer (`shared/dictation.ts`, `OfflineAudioContext`) e vai para o main
(`dictation:transcribe`), que o grava num arquivo temporário, roda o
`screenrx-transcribe` (`DictationService`, em pt-BR) e apaga o arquivo; o texto
entra no campo para ser lido antes de enviar. O acesso ao microfone é pedido ao
macOS pelo main (`dictation:request-microphone`), e o handler de permissões da
sessão passou a liberar áudio, além da câmera, para as janelas do app. Igual ao
ditado do Ovseer. **Não verificado:** nenhum ditado real. A ferramenta, o modelo e o esforço
são escolhidos num chip da barra de composição (`AiChoicePicker`: uma aba por
ferramenta pronta neste Mac, o modelo e um controle de esforço; a mesma preferência
da tela de Configurações e de "Sugerir cortes"). Cada mensagem é uma chamada nova à
CLI: vai o estado da edição (cortes, zooms, velocidade, legendas, fundo, câmera,
mudo), a transcrição numerada com marcadores de tempo a cada 10 s e as pausas
(até 12 000 palavras), e as últimas 12 mensagens da conversa; nada de áudio ou
vídeo. A resposta é `{ reply, actions }` com um objeto plano por ação (todos os
campos presentes, `null` nos que não se aplicam), o único formato que as três
ferramentas aceitam como saída estrita. Trechos vêm de preferência em índices de
palavra (um corte vai do início da primeira palavra ao início da seguinte à
última, como nas sugestões) ou em segundos quando não há fala. O parser descarta
tudo que o editor não oferece (velocidade fora da lista, fundo inexistente,
trecho inválido). As ações são aplicadas direto, como um único passo de desfazer
(`EditorStore.runAsOneStep`); a tradução de legendas é a exceção: começa e
termina sozinha, como pela aba Legendas. Um zoom sobre outro é recusado e aparece
riscado na resposta. A conversa vive só na memória do editor aberto. **Não
verificado:** nenhuma conversa real com as CLIs; só o prompt, o parser e o
aplicador têm testes.

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
  versão, com login (e em qual conta), modelos e níveis de esforço. O Claude Code
  não lista modelos: os oferecidos são os ids reais que apareceram nos registros de
  sessão dele (`~/.claude/projects/**/*.jsonl`, campo `model` de cada resposta;
  lidos só os 40 registros mais recentes dos últimos 90 dias, e só o fim de cada
  um), do mais recente para o mais antigo, com rótulo derivado do id ("Fable 5.1");
  sem nenhuma sessão, ficam os apelidos do CLI (`sonnet`, `opus`…). Os do
  Codex vêm do catálogo que ele guarda em `~/.codex/models_cache.json`; os do
  Antigravity, de `agy models`. Também instala (o instalador oficial de cada
  fornecedor, só depois de uma confirmação nativa) e inicia o login do Claude e
  do Codex (o próprio CLI abre o navegador; o fim é percebido consultando o
  status). O Antigravity não tem comando de login: entra na primeira execução no
  Terminal.
- **Privacidade:** só o texto da transcrição é enviado ao provedor da ferramenta
  escolhida, e só quando o usuário pede. Áudio, vídeo, caminhos e ids ficam no Mac.
- Transcrições muito longas são analisadas até 12 000 palavras, e o painel avisa.

### Tela inicial (biblioteca)

`Home.tsx`. Barra: busca "em títulos e transcrições" (⌘K foca; o título e o rótulo
da fonte são filtrados no renderer, e, depois de 250 ms parado, `library:search`
pergunta ao main quais transcrições contêm o texto — `SessionStore.searchTranscripts`
lê os `transcript.json` inteiros, com cache por mtime), engrenagem, importar
(ícone) e **Nova gravação** (⌘⇧R). Um vídeo arrastado para a janela também é
importado (`library:import-paths`, com o caminho obtido por `webUtils` no preload).
Cabeçalho "Gravações N" com ordem (mais recentes, mais antigas, nome, duração,
tamanho; só as duas primeiras agrupam por dia), grade/lista e, na lista, filtros
(Todas, Em edição, Com legendas, Exportadas, Importadas) e colunas Nome · Status ·
Duração · Tamanho. Cada gravação mostra até onde chegou (`RecordingSummary.progress`,
o passo mais avançado: exportada › com legendas › em edição › importada; vem do
`project.json`, lido na listagem, e de `lastExportAt` no `session.json`, gravado ao
terminar uma exportação) e, quando ainda tem o nome da fonte e já foi transcrita,
"Renomear para “…”" (`suggestTitle` sobre `transcriptPreview`, as primeiras
palavras ditas, guardadas no `session.json` ao transcrever e preenchidas na primeira
listagem para sessões antigas). Na grade, as ações (Editar, Finder, renomear,
excluir) aparecem sobre a capa ao passar o mouse. Rodapé: total de gravações e
tempo, e espaço usado. As reuniões ao vivo do Screen Live viram um banner cada
("está ao vivo · começou há N min · N participantes") com Ignorar e Gravar reunião;
sem reunião, nada aparece.

### Janelas

O app tem dois modos, e só um está na tela por vez. Abre na **biblioteca**; "Nova
gravação" esconde a biblioteca e mostra a **barra de gravação**. Fechar a barra,
terminar uma gravação ou um erro ao prepará-la devolvem a biblioteca (com a
gravação nova aberta no editor, ou com o motivo do erro). O `WindowManager`
concentra essa troca (`openRecorder` / `showLibrary`). O **ícone na barra de
menus** do macOS (`tray.ts`) é um atalho para o mesmo `openRecorder`: um clique
sobe a barra de gravação sem passar pela biblioteca; o clique direito oferece
biblioteca e sair.

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
  cache fora das sessões. "Importar vídeo" abre o seletor de arquivos (vários de
  uma vez) e traz cada um como uma sessão própria (ver §3); um único arquivo abre
  direto no editor, como uma gravação recém-terminada. A importação para no
  primeiro arquivo que falha; os anteriores já estão na biblioteca.
- **Câmera** — com a barra aberta e uma câmera selecionada, uma janela circular flutuante mostra a
  imagem dela para o usuário se enquadrar antes e durante a gravação. É só um
  espelho: como toda janela do app, fica fora da captura, e a trilha da câmera é
  gravada à parte pelo helper.

### Reuniões (Screen Live)

O app grava reuniões do Screen Live (`src/main/meet/`). Em Configurações o usuário
informa o endereço do Meet e o `API_RECORDER_TOKEN` do servidor, guardados pelo
main em `meet-settings.json` nos dados do app (`MeetSettingsStore`); o renderer
nunca recebe o token, só pede ao main que liste ou grave (`meet:*`). Com isso
configurado, a biblioteca mostra as **reuniões em andamento** (`GET /api/rooms`,
atualizado a cada 10 s e ao focar a janela) com um botão Gravar.

Gravar (`MeetRecorder.record`): o main emite um token de gravador
(`POST /api/rooms/{code}/join-tokens` com `recorder: true`), abre a `url` numa
**janela de reunião** (`WindowManager.openMeet`) e espera o Meet confirmar a entrada
(`GET /api/rooms/{code}` com `recording: true`, até 20 s). Essa janela não é uma
página do app: sem preload, sem confiança no IPC, navegação presa à origem do Meet,
`autoplayPolicy` liberado (o áudio da reunião precisa tocar para ser gravado) e sem
`backgroundThrottling`. Ela fica **fora do escudo de captura** de propósito: é a
única janela do app que deve aparecer numa gravação. Como as listagens de fontes
excluem o próprio app, o main monta a `WindowSource` a partir de
`getMediaSourceId()` e a entrega ao controller por `useSource`, junto com o título
"Reunião · nome". O vídeo vem do helper com `SCContentFilter(desktopIndependentWindow:)`, que
captura o conteúdo da janela mesmo coberta por outros apps (verificado: com uma janela
de outro app vermelha por cima, confirmada por screenshot do sistema, o vídeo gravado
continuou mostrando a reunião). A janela precisa continuar aberta e não minimizada. Medido em
2026-10-06: oculta (`hide`), minimizada ou com opacidade 0 fazem o vídeo parar de ser
entregue; posicionada quase toda fora dos monitores continua sendo capturada (o macOS
mantém uma faixa de cerca de 40×32 px visível num canto). Por isso a janela da
reunião **abre estacionada** além do canto inferior direito de todos os monitores
(`WindowManager.parkingBounds`), é mostrada sem tomar o foco (`showInactive`) e o
foco volta à biblioteca; só aquela faixa fica na tela, atrás dos outros apps. O
vídeo sai na resolução do monitor onde ela caiu (2560×1440 num monitor 2×). Em
desenvolvimento, `SCREENRX_MEET_WINDOW_VISIBLE=1` a abre num lugar visível.

**O áudio não vem do ScreenCaptureKit.** Medido com uma sonda: o macOS não entrega
o áudio dessa janela a nenhum filtro ligado à janela ou ao app (o áudio sai de um
processo auxiliar do Electron que ele não associa à janela); só um filtro de display
inteiro o recebe, e este misturaria os sons de outros apps. Por isso o áudio é
capturado **dentro da página**: no modo gravador o Meet mixa o áudio de todos os
participantes (Web Audio) e o grava com `MediaRecorder`, entregando os pedaços pela
ponte `window.screenrxMeetAudio`, exposta só à janela da reunião por um preload
próprio (`src/preload/meet.ts`: escrita apenas, nenhum outro canal). O
`MeetAudioCapture` ouve só a janela preparada para a reunião atual, só o frame
principal e só a origem do Meet, e grava os pedaços num arquivo temporário. Ao
terminar a gravação, o controller chama o gancho `externalSystemAudio` ainda dentro de
`complete()`, antes de anunciar a sessão (o editor abre assim que ela é anunciada e
não pode ficar sem a trilha). O gancho alinha o áudio ao relógio da gravação com o
FFmpeg (`buildAudioFilter`): corta o início de um áudio que começou antes do relógio
ou completa com silêncio o que começou depois, remove os trechos em pausa e fixa a
duração exatamente na do relógio; o resultado é o `system.m4a` da sessão (AAC
estéreo 48 kHz). O ponto zero do relógio é o `Date.now()` em que ele começou; o do
áudio, o do evento `start` do `MediaRecorder`, então o alinhamento tem a precisão de
algumas dezenas de milissegundos. Se a trilha falhar, a gravação é mantida com um
aviso `track-missing`. Gravação de reunião **não tem barra de gravação**: a biblioteca fica na tela
(`WindowManager.holdLibrary`, que impede o escudo de escondê-la) e mostra o aviso
`RecordingBanner` com o tempo, Pausar/Retomar e Finalizar. Terminar a gravação fecha
a janela da reunião; fechar a janela termina a gravação. No Meet, quem está na sala vê o aviso "Gravando" enquanto o
gravador estiver dentro, e o gravador não conta como pessoa.

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
removido da gravação. No preview a reprodução salta os cortes, e o cursor parado
nunca fica num trecho cortado: um seek para dentro de um corte (clique na linha do
tempo, ⏮, abertura do editor) vai para onde a edição retoma, e um corte feito em
volta do cursor o empurra para a parte mantida (`keptSourceTime`); a linha do tempo
continua desenhada no tempo de origem, com os trechos cortados escurecidos, e o
relógio mostra o tempo já editado. Um corte nunca pode deixar menos de
`minKeptDurationMs` de vídeo.

### Velocidade global × regiões de velocidade

São conceitos separados no modelo. `ExportSettings.speed` escala a linha do tempo
inteira no momento da exportação; `SpeedEffect` é uma edição criativa de um
trecho. O mapeamento de tempo e o grafo de áudio já tratam os dois (e os
multiplicam onde se sobrepõem); a interface ainda só oferece a velocidade global.

A velocidade global é escolhida **no editor**, no seletor ao lado do play
(`Transport`), e não só na hora de exportar: o preview toca nela
(`PreviewPlayer.applySpeed` ajusta `playbackRate` da tela, da câmera, das trilhas
de áudio e da dublagem, com o tom da voz preservado, como o `atempo` faz no
arquivo), e ao lado aparece a duração que o vídeo final terá. O diálogo de
exportação mostra o mesmo valor (`project.export.speed`), que continua sendo a
única fonte. A linha do tempo segue em tempo de edição, sem a velocidade.

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
- **Compactação** (`ExportSettings.compression`, 0 a 4, controle deslizante no
  diálogo): os níveis estão em `EXPORT_CONFIG.compressionLevels` — 0 e 1 são H.264
  (100% e 72% do bitrate), 2 a 4 são HEVC/H.265 (55%, 40% e 30%), com o áudio
  descendo de 192 a 96 kbps. HEVC mantém a nitidez com cerca de metade dos bits;
  gravação de tela, quase parada, segue nítida bem abaixo disso. HEVC sai pelo
  `hevc_videotoolbox` (ou `libx265` CRF 24 sem o hardware), com a tag `hvc1` para o
  QuickTime e o iPhone abrirem. O diálogo mostra o tamanho estimado
  (`estimatedFileBytes`: bitrates × duração + 2%). Projetos da primeira versão
  ('normal' | 'compact') leem como 0 e 2. O preview e os quadros são os mesmos; só
  o codificador muda. **Não verificado:** nenhuma exportação HEVC real pelo app (só
  um teste do FFmpeg com vídeo sintético: 1080p30, 3 s, 3,4 MB → 1,9 MB no nível 2).
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
- **Trilhas silenciadas** (`project.audio[trilha].muted`, o interruptor no rótulo
  da trilha na linha do tempo) continuam tocando mudas no preview, para o som
  voltar no mesmo instante, e simplesmente não são entregues ao FFmpeg na
  exportação; com todas silenciadas o arquivo sai sem trilha de áudio.
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
| Fim do áudio ainda a caminho quando o usuário para a gravação (o áudio chega em blocos, com atraso maior por Bluetooth) | As fontes de áudio seguem ligadas por 0,35 s depois do pedido de parada; o que foi ouvido antes da parada e chega nesse tempo é gravado, o que veio depois fica de fora. Sem isso a trilha do som do sistema terminava ~0,2 s antes do vídeo e a sessão recebia o aviso `duration-drift`. |
| Áudio que falta em uma trilha (o primeiro bloco chega depois do início; um bloco se perde em cada pausa) | O intervalo é preenchido com silêncio na gravação (`AudioEncoding.silenceToFill`), de modo que toda trilha de áudio começa em zero e segue o relógio. Sem isso, tudo o que vinha depois do intervalo tocava adiantado no valor dele. Um intervalo acima de 30 s não é preenchido: é o dispositivo que parou. |
| Dublagem: helper de voz ausente, modelo não baixado, download interrompido, síntese falha | `dub-unavailable` / `dub-model-missing` / `dub-download-failed` / `dub-failed`, explicados no painel; nenhuma trilha parcial fica na sessão e o resto do editor funciona. |
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
| — | Instalador para macOS (`npm run dist`): `.dmg` para Apple Silicon, assinatura local | **concluído**; assinatura Developer ID disponível (`dist:signed`) |
| — | Atualização automática (`electron-updater` + releases do GitHub; `make update` assina, notariza e publica; ver `docs/RELEASE.md`) | **implementada**; nenhuma versão publicada ainda, o fluxo completo (notarização, atualização de um app instalado) não foi exercitado |
| — | Legendas automáticas (pedido posterior à especificação): transcrição local, estilo, posição, edição do texto, exportação | **concluída** (só macOS 26+) |
| — | Sugestões de corte por IA (CLI do Claude, do Codex ou do Antigravity) a partir da transcrição | **concluída** (depende da transcrição: macOS 26+) |
| — | Assistente de edição em chat (coluna do editor; pede cortes, zooms, legendas, velocidade, fundo, câmera) | **implementado**; nunca conversado com uma CLI real |
| — | Configurações: instalar e entrar nas ferramentas de IA, escolher modelo e esforço | **concluída** (instalar e entrar sem verificação real) |
| — | Dublagem com voz clonada (OmniVoice em MLX, local), modelo baixado por dentro do app | **concluída** (só Apple Silicon; qualidade da voz não avaliada por ouvido) |

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
hardened runtime. O alvo `zip` existe só para a atualização automática (o app baixa o zip, o DMG é a primeira instalação). Só Apple Silicon por enquanto (os helpers e o FFmpeg são
compilados/baixados para a arquitetura da máquina que gera o pacote).

`npm run dist:check` abre o app empacotado com um perfil descartável e confere
assinatura, arquitetura dos executáveis, FFmpeg/FFprobe fora do arquivo, helper de
captura, transcritor, ferramentas de IA e a extração de uma capa. **Não
verificado:** abrir o app pelo Finder depois de instalado (é aí que o macOS pede
a permissão de Gravação de Tela em nome do "ScreenRx"; no teste o app é iniciado
pelo terminal e herda a permissão dele), a build assinada com Developer ID e a
instalação em outro Mac.

### Atualização automática

`src/main/update/UpdateService.ts` envolve o `electron-updater` e lê os releases de `jone22e/screenrx`
(`publish` do `electron-builder.yml`; o pacote leva um `app-update.yml` com esse destino). Consulta 10 s após abrir,
a cada 30 min, ao ganhar foco e ao acordar o Mac (nesses dois, só se a última consulta tem mais de 10 min), baixa
sozinho e instala ao sair do app (`autoInstallOnAppQuit`): o `before-quit` do app já finalizou uma gravação em
andamento antes disso. "Reiniciar agora" (`update:install`) é recusado com gravação ou exportação em curso. O estado
(`UpdateState`) vai à biblioteca (`UpdateNotice`) e a Configurações → Atualização pelo canal `update:state-changed`.
Em desenvolvimento o serviço fica em `unsupported`. O macOS só troca o app por uma versão com a mesma assinatura:
um app "ad hoc" (`make build-mac`) não se atualiza. `make update` (`scripts/release.sh`) assina com o Developer ID,
notariza e publica; passo a passo em `docs/RELEASE.md`. **Não verificado:** a notarização com o helper de voz, o
download e a troca de um app instalado por uma versão publicada.

### O que foi validado

`npm run test:e2e` conduz o app real e verifica mais de 85 pontos (ele grava a
tela e abre janelas por alguns minutos: vale rodar quando se mexe em gravação ou
exportação, não a cada mudança de interface), entre eles:

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
- trilhas e idioma: silenciar as trilhas na linha do tempo tira o áudio do arquivo
  exportado e religar as devolve; com a CLI substituta respondendo em chinês, as
  legendas traduzidas vão para o projeto sem alterar o texto falado, aparecem no
  preview, e alternar entre os idiomas não pede nova tradução;
- dublagem: com um helper de voz substituto, o modelo só é "baixado" quando
  pedido, a dublagem vira uma trilha da sessão do tamanho da gravação, ganha a
  faixa dela na linha do tempo no lugar do microfone, vai para o vídeo exportado e
  pode ser desligada. Com `SCREENRX_E2E_VOICE_MODELS` apontando para um modelo já
  baixado, o helper real clona a voz da gravação de teste e o transcritor confere
  que a trilha diz o texto traduzido (100% em chinês na verificação feita);
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
