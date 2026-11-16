# ScreenRx — Plano: editor profissional para redes sociais

Objetivo: gerar vídeos prontos para publicar em Reels, TikTok, Shorts, YouTube
e LinkedIn, **sem servidor** (tudo roda no Mac, como hoje). A versão web fica
adiada; este plano vale para o app desktop.

Ponto de partida (v0.1.6): cortes com sugestão da IA, zoom automático e manual,
legendas geradas no Mac com tradução e estilo, textos no instante, dublagem,
formatos 9:16 / 1:1 / 4:5 com enquadramento, fundo, câmera, filtros de imagem
e cor, assistente por conversa, exportação H.264 / HEVC.

Princípios que valem para todas as fases:

- O que aparece na tela nasce em `src/engine` (puro, testado com vitest) e é
  desenhado por `composeFrame`, que o preview e a exportação compartilham.
  Nenhuma fase cria um segundo caminho de render.
- Todo efeito continua em **tempo de origem**; nada aqui mexe nos três espaços
  de tempo (`SourceMs`, `TimelineMs`, `OutputMs`) a não ser a fase G3.
- Cada fase termina exportável: preview, exportação, undo/redo, salvar no
  `project.json` (com migração de schema quando o modelo muda) e ação do
  assistente quando faz sentido.
- Guias e sobreposições no preview ficam **desligadas por padrão**.

## Ordem e dependências

```
A  Legendas palavra a palavra      ─┐
B  Áudio (volume, música, ducking) ─┼─ independentes; começam juntas
C  Presets por plataforma + zonas seguras + capa ─┘
D  Regiões de velocidade + timeline profissional
G1 Imagens, logo e sticker        (usa "assets" da sessão, criado em B)
E  Cursor desenhado               (muda a captura; só gravações novas)
F  Animações de texto e transições
G2 B-roll (vídeo por cima)        (usa G1)
G3 Vários clipes no mesmo projeto (muda o modelo de tempo; por último)
H  SRT/VTT, templates de projeto, preview em moldura de celular (espalhado)
```

Tamanhos: **P** até 2 dias, **M** até uma semana, **G** mais de uma semana.

---

## Fase A — Legendas palavra a palavra (M) — FEITA em 2026-11-16

O que entrou: `CaptionCue.words`, modos `block` / `highlight` / `reveal`,
`highlightColor`, animação `pop` / `fade`, tamanhos "1 palavra" e "2–3",
legenda que não pisca entre cues próximas, estilos prontos, ações do
assistente, SRT/VTT (salvar no tempo do vídeo exportado, importar). Verificado
com testes e com um harness que desenha quadros reais do `composeFrame`
(`tmp/caption-harness`, fora do git); não foi aberto no app em si porque o
app instalado estava em uso. Detalhes em `docs/ARCHITECTURE.md`, "Legendas".


O padrão de Reels/TikTok: uma a três palavras por vez, a palavra falada em
destaque, entrada animada. O transcript já traz cada palavra com tempo
(`TranscriptWord`), então é só modelo + desenho.

Modelo (`src/shared/models/project.ts`):

- `CaptionCue` ganha `words: Array<{ startMs; endMs; text }>` (já calculadas em
  `buildCues`; hoje descartadas). Tradução continua por cue; quando há tradução
  ativa, o destaque cai para "cue inteira", porque a tradução não tem tempo por
  palavra.
- `CaptionStyle` ganha `mode: 'block' | 'highlight' | 'one-word'`,
  `highlightColor`, `animation: 'none' | 'pop' | 'fade'`.
- `CaptionLength` ganha `'word'` (1 palavra) e `'pair'` (2 a 3 palavras).

Motor (`src/engine/captions`): `captionAt` passa a devolver `{ text, activeWordIndex }`;
`captionLayout` já quebra em `Piece`s, falta marcar a peça ativa. Novo
`captionAnimation.ts` com a escala/alpha do instante (easing igual ao do zoom).

Render: `drawCaption` em `composeFrame.ts` desenha a palavra ativa com
`highlightColor` e aplica a animação. Mesmo código no preview e na exportação.

UI: `CaptionsPanel` ganha "Modo", "Cor de destaque" e "Animação". Três presets
visíveis ("Clássico", "Destaque", "Uma palavra"). Assistente: ação
`caption-style` com esses campos.

Pronto quando: um vídeo 9:16 exporta com legenda uma palavra por vez e destaque
colorido idêntico ao preview; teste de `captionAt` com índice da palavra ativa.

## Fase B — Áudio de verdade (M) — FEITA em 2026-11-16

O que entrou: volume por trilha, música da sessão (`music.m4a`, importador
próprio, substituir e remover), volume/ducking/repetir/fades da música,
ducking real por `sidechaincompress` na exportação e aproximado pela
transcrição no preview, loudness −14 LUFS na exportação, aba Áudio, ações do
assistente `volume` e `music-ducking`. Desvios do plano original: em vez de
uma pasta `assets/` com ids, a música é uma trilha única da sessão (mais
simples; a pasta de assets fica para as imagens da fase G1); sem fades por
trilha gravada (só na música); sem faixa da música na linha do tempo (ela
corre no relógio de saída e ficaria desalinhada dos cortes). Verificado por
testes com o FFmpeg real (ducking de 11 dB com voz a −27 dB, fades, −14
LUFS) e pelo importador em sessão temporária; o preview da música não foi
ouvido no app. Detalhes em `docs/ARCHITECTURE.md`, "Exportação".

Plano original, para referência:

Modelo:

- `AudioTrackSettings` ganha `volume` (0 a 2) e `fadeInMs` / `fadeOutMs`.
- `Project` ganha `music: { assetId; volume; startMs; loop; ducking: 'off' | 'light' | 'strong' } | null`.
- `Project.export` ganha `loudness: 'off' | 'social'` (−14 LUFS, padrão das plataformas).

Sessão: nasce a pasta `assets/` dentro da sessão (manifesto lista os assets com
id, tipo e nome). Novo `MusicImporter` em `src/main/library`, espelho do
`VideoImporter`: copia ou reencoda para AAC, nunca toca o original. IPC
`library.importAudio(sessionId)`. Esse conceito de asset é reaproveitado por G1/G2.

Preview (`PreviewPlayer.ts`): os `Audio` passam por um `AudioContext` com um
`GainNode` por faixa; ducking no preview é aproximado pelas palavras do
transcript (fala presente → ganho da música desce com rampa de 150 ms).

Exportação (`src/engine/export/audioFilters.ts`): `buildAudioGraph` ganha
`volume`, `afade`, `sidechaincompress` (ducking de verdade, pela voz) e
`loudnorm` ao final. A música entra como mais uma entrada do FFmpeg, com `aloop`
quando `loop`.

UI: nova aba **Áudio** (microfone, sistema, música, cada uma com volume, fades
e mudo; música com "Escolher arquivo…"). A forma de onda da música aparece na
timeline. Assistente: `mute` já existe; ganha `volume` e `music-ducking`.

Pronto quando: música importada toca abaixo da fala, abaixa quando há voz,
entra e sai com fade, e a exportação mede −14 LUFS no `ffmpeg -af ebur128`.

## Fase C — Presets por plataforma, zonas seguras e capa (P)

Modelo: `ExportSettings` ganha `preset: 'custom' | 'reels' | 'tiktok' | 'shorts' | 'youtube' | 'linkedin' | 'x'`.
Tabela em `src/engine/export/platformPresets.ts`: aspecto sugerido, largura
máxima, fps, bitrate, duração máxima, tamanho máximo. `createExportPlan` lê
o preset; `estimatedFileBytes` e a duração mapeada geram **avisos** no
`ExportDialog` ("Reels aceita até 90 s; seu vídeo tem 2 min 10 s").

Lote: o diálogo permite marcar vários presets; `ExportService` roda um após o
outro com sufixo no nome (`-reels`, `-youtube`).

Zonas seguras: `src/engine/rendering/safeZones.ts` devolve, por aspecto e
plataforma, as áreas cobertas pela interface do app (barra inferior, coluna
direita). O preview desenha as guias quando o usuário liga "Mostrar zonas
seguras" (desligado por padrão). As posições padrão de legenda e texto passam
a respeitar a zona.

Capa: IPC `export.frame(sessionId, timeMs)`; o renderer compõe o quadro em
tamanho de exportação e o main salva PNG ao lado do MP4. Botão "Salvar capa
deste quadro" no `Transport`.

Pronto quando: exportar "Reels + Shorts" gera dois arquivos nos limites de cada
plataforma, com aviso quando estoura, e a capa sai em PNG.

## Fase D — Regiões de velocidade e timeline profissional (M)

O motor já tem `SpeedEffect`, `timeMapping` e o grafo de áudio por região.
Falta a interface.

- Timeline: faixa de velocidade, criada a partir da seleção (igual ao zoom),
  redimensionável com `spanEditing`; etiqueta "2×" na região.
- `EditorStore`: `addSpeedSpan`, `setSpeedFactor`, `removeSpeed`.
- Atalhos: `J K L` (voltar / pausar / avançar), `← →` por quadro, `I O`
  (início / fim da seleção), `S` (cortar no cursor), `M` (marcador),
  `+ −` (zoom da timeline).
- Marcadores: `Project.markers: Array<{ id; timeMs; label }>`, desenhados na
  régua, navegáveis com `Shift+M`.
- Assistente: `speed` por região (`startMs`, `endMs`, `factor`).

Pronto quando: acelerar um trecho a 3× com a voz mantendo o tom exporta certo
e o atalho `S` divide um corte no cursor.

## Fase G1 — Imagens, logo e sticker (M)

Primeira "camada" de verdade, sem mexer no modelo de tempo.

Modelo: `Project.layers: Layer[]`, com `Layer = { id; kind: 'image'; assetId; startMs; endMs; position; sizeRatio; rotation; opacity; cornerRadiusRatio }`.
Assets de imagem entram na pasta `assets/` da sessão (fase B). Logo com
"tempo inteiro" é só uma layer que cobre toda a duração.

Render: `composeFrame` desenha as layers entre a câmera e as legendas, na
ordem da lista. As imagens vêm decodificadas em `ImageBitmap` pelo renderer
(preview e exportação iguais).

UI: aba **Camadas** com lista ordenável; arrastar e redimensionar no preview
(reaproveita a manipulação da câmera); timeline com uma faixa por camada.

Pronto quando: um logo no canto e um sticker de 3 s exportam idênticos ao preview.

## Fase E — Cursor desenhado (M)

O cursor hoje é queimado na captura. Para desenhar, a captura precisa parar de
incluí-lo.

- Helper Swift: opção `showsCursor: false` na configuração do ScreenCaptureKit,
  controlada por `CaptureDefaults`; o manifesto da sessão registra
  `cursorBurnedIn: boolean` para o editor saber o que fazer com gravações antigas.
- Modelo: `Project.cursor: { visible; sizeRatio; clickHighlight; smoothing }`.
- Render: `composeFrame` desenha a seta (asset SVG do app) na posição de
  `cursorPath` (já suavizada para o zoom) e um círculo que se expande nos
  cliques de `interactions.json`, dentro do recorte do zoom, então o cursor
  escala com o zoom como no Screen Studio.
- UI: aba **Cursor** (tamanho, destaque de clique, suavização).

Pronto quando: gravação nova exporta com cursor grande e suave e clique
destacado; gravação antiga mostra a aba desativada com o motivo.

## Fase F — Animações de texto e transições (M)

- `TextOverlay` ganha `enter` / `exit: { kind: 'none' | 'fade' | 'pop' | 'slide-up'; durationMs }`.
  `captionAnimation.ts` da fase A vira `src/engine/rendering/animation.ts`,
  usado por legendas e textos.
- Templates de texto: "Título", "Subtítulo", "Lower third", "Chamada" em
  `src/engine/rendering/textTemplates.ts` (estilo + animação + posição).
  O `TextPanel` oferece os templates antes do texto livre.
- Transições nos cortes: `TrimEffect` ganha `transition: 'cut' | 'dip' | 'crossfade'`.
  `dip` (escurece e volta) é só um fator de alpha em `composeFrame` ao redor da
  borda do corte. `crossfade` precisa de dois quadros no mesmo instante: o
  `TrackFrameReader` ganha um segundo leitor para a borda seguinte. Fazer `dip`
  primeiro; `crossfade` só se sobrar fôlego.

Pronto quando: um título entra com pop e sai com fade; um corte com `dip`
exporta igual ao preview.

## Fase G2 — B-roll: vídeo por cima (G)

`Layer` ganha `kind: 'video'` (asset `.mp4` importado como em `VideoImporter`,
com as mesmas regras de H.264 8 bits). Preview: um `<video>` por camada
visível, sincronizado como a webcam. Exportação: um `TrackFrameReader` por
camada. Áudio do b-roll entra no grafo com volume próprio.

Pronto quando: um trecho de 5 s de outro vídeo cobre a tela e exporta.

## Fase G3 — Vários clipes no mesmo projeto (G)

A única fase que muda os espaços de tempo. `Project` passa a ter
`clips: Array<{ sessionId; inMs; outMs }>` em sequência; o tempo de origem
vira `(clipIndex, SourceMs)` e `timeMapping` concatena os clipes antes dos
cortes. Tudo que hoje é "por sessão" (transcript, cursor, webcam, áudio)
passa a ser "por clipe". Exportação e preview trocam de leitor na fronteira.

É a fase mais cara e a mais arriscada; só vale depois que A–F estiverem
estáveis e o uso pedir. Até lá, "juntar duas gravações" pode ser feito na
biblioteca com FFmpeg (`concat`) como uma importação.

## Fase H — Miudezas que se espalham (P cada)

- **SRT / VTT**: exportar as legendas (`captions.exportSubtitles`) e importar
  um arquivo como cues. Entra junto com a fase A.
- **Templates de projeto**: salvar fundo, estilo de legenda, música, formato e
  preset de exportação em `~/Library/Application Support/ScreenRx/templates/`
  e aplicar na abertura de uma gravação nova. Entra depois de B e C.
- **Moldura de celular no preview**: para 9:16, opção de ver o quadro dentro
  de uma moldura com a interface simulada do app (desligada por padrão).
  Entra com C.

---

## O que não entra neste plano

- Gravação de tela no navegador e qualquer backend (decidido: offline).
- Efeitos que exigem GPU dedicada ou modelo pesado além dos já embarcados.
- Windows: continua na fase 9 do plano original.
