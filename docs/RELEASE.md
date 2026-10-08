# Publicar uma versão do ScreenRx

O app se atualiza sozinho. Ele consulta os releases de `jone22e/screenrx` no GitHub 10 segundos depois de abrir, a
cada 30 minutos, ao voltar ao primeiro plano e quando o Mac acorda (nesses dois casos, só se a última consulta foi
há mais de 10 minutos), baixa a versão nova em segundo plano e instala quando o usuário fecha o app. Quando a
versão já está baixada, a biblioteca mostra "ScreenRx X está pronto para instalar" com o botão **Reiniciar agora**,
que só funciona sem gravação nem exportação em andamento. Em Configurações → Atualização dá para ver a versão
instalada e forçar a consulta.

Só o Apple Silicon (arm64) é publicado, como o instalador.

Publicar uma versão é rodar um comando:

```bash
make update
```

## Comandos

| Comando | O que faz |
|---|---|
| `make update` | Sobe a versão de correção (0.1.0 → 0.1.1) e publica |
| `make update-minor` | Sobe a versão de funcionalidade (0.1.3 → 0.2.0) e publica |
| `make update-major` | Sobe a versão principal (0.2.1 → 1.0.0) e publica |
| `make update VERSION=1.4.0` | Publica com o número informado |
| `make release` | Publica a versão que já está no `package.json`, sem subir o número |
| `make build-mac` | Gera o instalador local em `release/`, assinatura "ad hoc", sem publicar (era o antigo `make update`) |
| `make check` | Confere o app empacotado em `release/` |

## O que o `make update` faz

1. Confere o ambiente: Mac com Apple Silicon, certificado, credencial de notarização, login no GitHub, branch
   `main` sem alterações pendentes e em dia com o servidor.
2. Sobe o número da versão no `package.json`.
3. Roda a checagem de tipos e os testes.
4. Compila, assina com o Developer ID e envia para a Apple notarizar (o helper de voz compila na primeira vez, uns
   4 minutos).
5. Sobe o DMG, o zip e o `latest-mac.yml` para um release em rascunho no GitHub.
6. Roda o teste do app empacotado (`npm run dist:check`): helpers, FFmpeg, assinatura e a abertura do app.
7. Faz o commit `chore: versão X`, cria a tag `vX` e envia para o servidor.
8. Tira o release do rascunho. A partir daí os apps instalados enxergam a versão.

Se algo falhar antes do passo 7, o número da versão volta ao que era e nada fica visível para os usuários.

Leva de 10 a 20 minutos, quase tudo na notarização.

## Antes de publicar

Faça o commit e o push do que vai entrar na versão. O comando se recusa a rodar com alterações pendentes.

## A primeira instalação

A atualização automática só troca um app **assinado com o mesmo Developer ID**. O app instalado a partir de um
`make build-mac` (assinatura "ad hoc") não se atualiza: baixe o DMG do primeiro release publicado, instale por
cima e, dali em diante, as versões chegam sozinhas. As permissões (Gravação de Tela, microfone, câmera) são
pedidas uma vez de novo nessa troca, porque a identidade do app muda. Com o Developer ID, as versões seguintes
mantêm as permissões.

Um app gerado por `make build-mac` também consulta o GitHub, mas não consegue instalar o que baixa: o erro
aparece em Configurações → Atualização.

## Preparar uma máquina nova (uma vez)

1. **Certificado.** `security find-identity -v -p codesigning` deve listar
   `Developer ID Application: C2S Business Ltda (3UG973ND38)`. O `Apple Distribution` não serve: é para a App Store.
2. **Credencial de notarização.** Gere uma senha específica de app em account.apple.com (Sign-In and Security →
   App-Specific Passwords) e guarde no keychain. O perfil padrão é o `ovseer-notary`, o mesmo do Ovseer; para
   usar outro nome, `APPLE_KEYCHAIN_PROFILE=<nome> make update`.

   ```bash
   xcrun notarytool store-credentials "ovseer-notary" --apple-id "SEU_APPLE_ID" --team-id 3UG973ND38
   ```

3. **GitHub.** Entre com uma conta que tenha permissão de escrita no repositório: `gh auth login`.
4. **Swift e Node.** As ferramentas de linha de comando do Xcode (`xcode-select --install`) e o Node 22.12 ou mais novo (`engines` do `package.json`).

## Conferir se a atualização chegou

Abra o app instalado em uma versão anterior. Em cerca de 10 segundos aparece a barra "ScreenRx X está pronto para
instalar" (o download leva o tempo do zip). Os logs ficam em `~/Library/Logs/ScreenRx/main.log`, com o prefixo `[update]`.

## Texto do release

O `make update` preenche o texto com os commits que entraram desde a versão anterior. Para reescrever:

```bash
gh release edit v0.1.1 --notes "Texto novo"
```

## Problemas comuns

| Sintoma | Causa |
|---|---|
| `ambiguous (matches "Apple Distribution…")` | Falta o certificado Developer ID Application |
| `Credencial de notarização "ovseer-notary" não encontrada` | O passo 2 da preparação não foi feito nesta máquina |
| O app não acha a versão nova | O release ainda está em rascunho, ou o número não é maior que o instalado |
| "Disponível só no app instalado" nas Configurações | O app está rodando em modo de desenvolvimento (`npm run dev`) |
| `HTTP status code: 403. A required agreement is missing or has expired` | A Apple publicou um contrato novo que o titular da conta precisa aceitar em developer.apple.com |
| `No Keychain password item found for profile` no meio da publicação | O Mac bloqueou a tela ou dormiu: a credencial só pode ser lida com a sessão desbloqueada. Desbloqueie e rode de novo; o rascunho do release é reaproveitado |
| A notarização falha | Veja o motivo com `xcrun notarytool log <id> --keychain-profile ovseer-notary` |

## Onde está o código

| Arquivo | Papel |
|---|---|
| `src/main/update/UpdateService.ts` | Consulta, download e instalação |
| `src/renderer/src/app/UpdateNotice.tsx`, `src/renderer/src/settings/Settings.tsx` | Aviso na biblioteca e seção em Configurações |
| `scripts/release.sh` | Passos do `make update` |
| `electron-builder.yml` | Assinatura, notarização e destino da publicação |
| `build/entitlements.mac.plist` | Permissões do app assinado |
