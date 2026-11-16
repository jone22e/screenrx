# ScreenRx — Projeto: edição completa por IA, com vários agentes ao mesmo tempo

Objetivo: um botão **"Editar com IA"** no editor que entrega, em menos de um
minuto, um primeiro corte completo do vídeo para redes sociais — cortes,
velocidade, zooms e enquadramento, legendas estilizadas, títulos, música,
logo, preset de exportação — feito por **vários agentes em paralelo**, cada
um dono de uma parte da edição, com o usuário vendo "várias mãos" (cursores
coloridos) trabalhando na linha do tempo e no preview, e podendo desfazer ou
refazer o trabalho de cada um.

Tudo o que já existe continua valendo: o resultado é uma edição comum do
projeto (não destrutiva, com desfazer), feita só com as ações que o assistente
já sabe aplicar, validadas pelo mesmo parser. Nada sai do Mac além de texto.

## 1. O que já existe e é reaproveitado

| Peça | Onde | Uso aqui |
| --- | --- | --- |
| Ferramentas de IA por CLI (Claude, Codex, Antigravity), resposta estruturada por JSON Schema, cwd vazio, sem ferramentas | `src/main/ai/AiCliService.ts` | o único canal com a IA; vira um **pool** com N processos |
| Assistente: prompt com estado da edição + transcrição numerada + conversa; parser que valida cada ação (tempos dentro da gravação, fatores da lista, ids reais) | `src/engine/assistant/assistantPrompt.ts`, `src/main/ai/AssistantService.ts` | os agentes falam a **mesma língua de ações**; o parser é reaproveitado com um filtro de tipos por papel |
| Aplicação das ações como um passo de desfazer | `src/renderer/src/editor/assistantActions.ts` (`runAsOneStep`) | cada agente vira **um passo de desfazer** |
| Ações disponíveis (todas as fases A–H) | `AssistantAction` | cut, uncut, zoom, remove-zoom, speed, speed-region, captions, caption-language/length/mode/animation, background, format, framing, export-preset, webcam, mute, volume, music-ducking, text |
| Sugestões de corte (silêncios, hesitações) e pausas longas | `CutSuggestionService`, `quickFixes.ts` | entradas prontas para o agente Cortador |
| Telemetria (cliques, cursor), transcrição com palavras, imagens e música da sessão, presets por plataforma | sessão + `platformPresets.ts` | a **ficha da gravação** que todos os agentes recebem |

## 2. Como funciona, em quatro passos

```
 usuário: "Editar com IA" + plataforma + duração alvo + tom
      │
      ▼
 1. DIRETOR (1 chamada, esforço alto)
    ficha da gravação → plano: capítulos, o que cortar por alto, estilo, quais agentes rodam e o briefing de cada um
      │
      ▼
 2. EQUIPE (N chamadas EM PARALELO, esforço médio/baixo)
    Cortador · Câmera · Legendista · Som · Arte — cada um dono de pistas próprias, devolve ações + motivo
      │
      ▼
 3. MONTAGEM (no editor, sem IA)
    aplica as ações de cada agente como um passo de desfazer, na ordem das pistas, com as regras de conflito;
    enquanto aplica, anima um cursor colorido por agente na linha do tempo e no preview ("várias mãos")
      │
      ▼
 4. REVISÃO (opcional, 1 chamada)
    o Diretor vê o estado final e pede retoques; o usuário vê a lista do que cada agente fez e desfaz ou refaz por agente
```

### 2.1 A ficha da gravação (`engine/ai/recordingSheet.ts`)

Texto, gerado uma vez e dado a todos os agentes. Nada de pixels na v1.

- Duração, formato de origem, se tem câmera, microfone, som do sistema,
  música (nome), imagens disponíveis (nomes), cursor desenhado ou não.
- Transcrição numerada com marcadores de tempo e pausas (a do assistente).
- **Densidade de ação**: por janela de 10 s, quantos cliques, quanto o cursor
  andou, se há fala. É o que diz onde vale zoom, onde vale acelerar e onde
  vale cortar (silêncio sem ação = cortar; ação sem fala = acelerar).
- Pausas longas e sugestões de corte já calculadas (`longPauses`,
  `CutSuggestionService` quando disponível).
- Estado atual da edição (o `AssistantEditState` de hoje).
- A plataforma escolhida e seus limites (`platformPresets.ts`), a duração
  alvo e o tom ("tutorial direto", "bastidores", "anúncio").

### 2.2 O Diretor (`engine/ai/directorPrompt.ts`)

Uma chamada com esforço alto. Resposta estruturada:

```
{
  "summary": "…",
  "chapters": [{ "fromWord": 0, "toWord": 120, "title": "Abrindo o projeto" }, …],
  "preset": "reels" | …,
  "targetDurationSec": 85,
  "style": { "captions": "highlight" | "block" | "reveal", "tone": "…" },
  "workers": [
    { "role": "cutter", "brief": "corta a intro até a palavra 40; acelera a instalação (palavras 300–420) a 3x" },
    { "role": "camera", "brief": "zoom nos cliques do menu em 0:42 e 1:10; formato 9:16 seguindo o mouse" },
    …
  ]
}
```

O Diretor não produz ações: produz **briefings**. Isso mantém a chamada curta
e deixa o trabalho fino para quem corre em paralelo.

### 2.3 A Equipe: um agente por pista, sem conflito

| Agente | Pistas que possui | Ações permitidas | Entradas além da ficha |
| --- | --- | --- | --- |
| **Cortador** | cortes, velocidade | cut, uncut, speed-region, speed | pausas longas, sugestões de corte, duração alvo |
| **Câmera** | zoom, formato/enquadramento, câmera | zoom, remove-zoom, format, framing, webcam | cliques por janela, preset |
| **Legendista** | legendas, textos | captions, caption-mode/length/animation/language, text | capítulos do Diretor (um título por capítulo), estilo |
| **Som** | áudio, música | volume, mute, music-ducking | se há música, se o som do sistema tem fala |
| **Arte** | fundo, exportação, (camadas e capa na v2) | background, export-preset | imagens disponíveis, preset |

Regras:

- Cada agente só pode emitir os tipos da sua coluna; o parser descarta o
  resto. **Propriedade por pista** é o que torna a paralelização segura: dois
  agentes nunca escrevem na mesma pista.
- Cada ação vem com um `reason` curto (uma frase), para a lista de revisão.
- Limites: até 60 ações por agente; `cutSpans` continua garantindo o mínimo
  mantido da gravação; o Cortador recebe a duração alvo e o total que já cortou.
- Esforço: Diretor alto; agentes médio (Cortador e Legendista) e baixo (Som,
  Arte). Modelos por papel configuráveis em Configurações ("Equipe de IA").

### 2.4 Montagem e as regras de conflito

No editor, sem IA, em ordem fixa, cada agente como **um passo de desfazer**:

1. Cortador (cortes e velocidade) — primeiro, porque define o tempo que sobra.
2. Câmera — zooms que caírem inteiramente dentro de um corte são descartados.
3. Legendista — textos dentro de um corte são descartados; um título de
   capítulo que caia em corte vai para o primeiro instante mantido depois dele.
4. Som e Arte — ajustes globais, sem conflito.

Dentro de uma pista valem as regras que já existem (`spanForNew`, a
substituição em `addSpeedSpan`, a absorção de cortes vizinhos em `cutSpans`).

### 2.5 "Várias mãos": os cursores dos agentes

O que o usuário vê enquanto a montagem acontece, e o que dá a sensação de
uma equipe editando:

- **Um cursor colorido por agente** (cor fixa por papel: Cortador vermelho,
  Câmera roxo, Legendista amarelo, Som verde, Arte azul), com o nome ao lado,
  desenhado por cima da linha do tempo e do preview (`AgentCursorsLayer`, uma
  camada DOM posicionada; nada vai para o canvas da exportação).
- As ações de cada agente são aplicadas **uma a uma, escalonadas**: o cursor
  vai até a pista e o instante da ação (x pelo tempo, y pela pista), a região
  criada pisca, e no preview o cursor vai ao ponto de um zoom ou de um texto.
  Os cinco cursores andam ao mesmo tempo, cada um na sua pista.
- Velocidade: o escalonamento é `min(60 ms, 2 s ÷ ações)` por agente, então a
  montagem inteira **nunca passa de 2 s** por agente, por mais ações que haja;
  o show não atrasa o resultado.
- Painel "Equipe" ao lado: cada agente com estado (pensando → aplicando →
  pronto), número de ações, tempo, e botões **Desfazer este** (desfaz só o
  passo daquele agente, mesmo que outros venham depois — é um desfazer
  seletivo: reaplica os outros passos por cima) e **Refazer este com…** (um
  campo de instrução extra; só aquele agente roda de novo).
- Lista do que foi feito, por agente, com o motivo de cada ação; clicar vai ao
  instante.

### 2.6 Revisão (opcional, desligada por padrão)

Uma segunda chamada ao Diretor com o estado final em texto: ele pode pedir
retoques (uma legenda que cobre um lower third, um corte que deixou uma frase
pela metade). Custa 10 a 15 s a mais; o usuário liga em Configurações.

## 3. Rapidez: onde o tempo vai e como fica curto

| Etapa | Hoje (assistente, 1 pedido) | No projeto |
| --- | --- | --- |
| Ficha da gravação | — | < 100 ms (local) |
| Diretor | — | 8–15 s (uma chamada, esforço alto, resposta curta) |
| Equipe | sequencial, um pedido por vez (`ai-busy`) | **5 em paralelo**, 10–20 s no total (o mais lento manda) |
| Montagem | instantânea | ≤ 2 s por agente, simultâneos |
| **Total** | vários minutos de conversa | **~30 a 40 s** |

O que muda no código para isso: `AiCliService` deixa de ser single-flight
(`running` → `Map<id, AbortController>` com um limite de processos
simultâneos, padrão 5, configurável; `ai-busy` só acima do limite; `cancel`
por pedido e `cancelAll`). Os CLIs já aceitam várias instâncias ao mesmo
tempo; o limite real é a cota da conta de cada ferramenta — por isso o
Diretor usa esforço alto e os agentes esforço médio/baixo, e o usuário vê o
custo estimado (número de chamadas) antes de começar.

## 4. Mudanças por camada

- **`src/engine/ai/`** (puro, testável): `recordingSheet.ts` (ficha),
  `directorPrompt.ts` (prompt + schema + parse do plano), `workerPrompts.ts`
  (um prompt por papel, tipos permitidos, filtro sobre `parseAssistantResponse`),
  `assembly.ts` (ordem e regras de conflito sobre as ações, sem store).
- **`src/main/ai/`**: `AiCliService` em pool; `AutoEditService` (orquestra
  Diretor → Equipe em `Promise.all` → resultado), progresso por evento
  (`ai:auto-edit-progress`: agente, estado, tempo).
- **IPC**: `ai:auto-edit(sessionId, brief, choice)` →
  `{ plan, workers: [{ role, actions, reasons, elapsedMs }] }`;
  `ai:auto-edit-cancel`; `ai:auto-edit-rerun(sessionId, role, instruction)`.
- **Renderer**: botão "Editar com IA" na barra do editor; diálogo de briefing
  (plataforma, duração alvo, tom, quais agentes); `AgentCursorsLayer`; painel
  "Equipe"; no `EditorStore`, `applyWorkerActions(role, actions)` com passo de
  desfazer nomeado e `undoStep(role)` (desfazer seletivo: refaz os passos
  posteriores por cima a partir do histórico).
- **Configurações**: seção "Equipe de IA" (modelo e esforço por papel, limite
  de processos, revisão ligada/desligada).

## 5. Privacidade e limites

- Só texto sai do Mac: transcrição, números da telemetria (cliques por
  janela, não posições), nomes de arquivo das imagens e da música, estado da
  edição. Nenhum quadro do vídeo na v1.
- v2 (opcional, com aviso explícito): um agente "Olho" recebe 6 a 10 quadros
  pequenos (capítulos e cliques) pela entrada de imagem do CLI, para escolher
  a capa e detectar o que está na tela. Fica desligado até o usuário ligar.
- Tudo é desfazível; nada é exportado sem o usuário clicar em Exportar.

## 6. Entregas — I1 a I4 FEITAS em 2026-11-16

Depois da primeira rodada no app, Jone pediu a edição à vista, sem modal, e
um painel mais profissional: a equipe passou para o painel do Assistente, com
cada agente pousando suas ações uma a uma na linha do tempo assim que termina,
cursor colorido junto, e detalhes só ao abrir cada agente. Implementado na
mesma sessão em que o projeto foi escrito: pool no
`AiCliService`, ficha da gravação, Diretor, cinco agentes com filtro de
ações, montagem com regras de conflito, diálogo "Editar com IA" com
progresso, lista por agente, cursores na linha do tempo, desfazer e refazer
por agente. Padrões assumidos: 5 processos, Cortador e Legendista em esforço
médio e os demais baixo, nenhum quadro sai do Mac. Não feito: a revisão
opcional do Diretor (I4, parte) e o "Olho" (I5). Nenhuma chamada real às
ferramentas foi feita ainda: a primeira rodada com uma gravação de verdade
é o próximo passo, e vai calibrar prompts e limiares.

Plano original, para referência:

1. **I1 — Pool e Diretor (1 semana).** `AiCliService` em pool com limite;
   ficha da gravação; prompt e parse do plano; teste com os três CLIs em
   `SCREENRX_AI_LIVE=1`. Pronto quando o Diretor devolve um plano válido para
   uma gravação real em menos de 15 s.
2. **I2 — Equipe e montagem (1 semana).** Cinco papéis, filtro de ações,
   `assembly.ts` com as regras de conflito, `applyWorkerActions` por agente,
   diálogo de briefing e botão. Pronto quando "Editar com IA" num screencast
   de 5 min entrega cortes, zooms, legendas, títulos, música e preset em
   menos de 45 s, com um passo de desfazer por agente.
3. **I3 — Várias mãos (3 dias).** `AgentCursorsLayer`, escalonamento das
   ações, painel Equipe com estados e lista por agente.
4. **I4 — Revisão e refazer por agente (3 dias).** Desfazer seletivo, "Refazer
   este com…", revisão opcional do Diretor.
5. **I5 — Olho (opcional).** Quadros para capa e contexto visual, atrás de uma
   opção explícita.

## 7. Perguntas para decidir antes do I1

- Quantos processos de CLI ao mesmo tempo a conta de cada ferramenta aguenta
  sem rate limit? (Começar com 5 e medir.)
- Esforço padrão dos agentes: médio custa mais; baixo erra mais nos cortes.
  Proposta: Cortador e Legendista médio, o resto baixo.
- Quadros do vídeo podem sair do Mac, mesmo atrás de uma opção? Se não, o
  "Olho" (I5) não existe e a capa continua manual.
