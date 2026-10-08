#!/usr/bin/env bash
# Gera e publica uma versão do ScreenRx para macOS (ver docs/RELEASE.md).
#   scripts/release.sh patch|minor|major|x.y.z   sobe a versão e publica
#   scripts/release.sh current                   publica a versão que já está no package.json
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
REPO="jone22e/screenrx"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-ovseer-notary}"

fail() { echo "✗ $1" >&2; exit 1; }
step() { echo; echo "▸ $1"; }

step "Conferindo o ambiente"
[ "$(uname)" = "Darwin" ] || fail "A versão do macOS só pode ser gerada em um Mac."
[ "$(uname -m)" = "arm64" ] || fail "O ScreenRx é só para Apple Silicon: gere a versão em um Mac M1 ou mais novo."
command -v gh >/dev/null || fail "GitHub CLI não encontrado (brew install gh)."
gh auth status >/dev/null 2>&1 || fail "GitHub CLI sem login (gh auth login)."
security find-identity -v -p codesigning | grep -q "Developer ID Application: C2S Business Ltda" \
  || fail "Certificado Developer ID Application não encontrado no keychain."
NOTARY_CHECK="$(xcrun notarytool history --keychain-profile "$PROFILE" 2>&1 >/dev/null)" \
  || fail "Notarização indisponível (credencial \"$PROFILE\", Mac bloqueado ou acordo pendente na Apple; ver docs/RELEASE.md):
$NOTARY_CHECK"
[ "$(git branch --show-current)" = "main" ] || fail "Publique a partir da branch main."
[ -z "$(git status --porcelain)" ] || fail "Há alterações não commitadas. Faça o commit antes de publicar."
git fetch --quiet origin main
[ -z "$(git rev-list HEAD..origin/main)" ] || fail "A main local está atrás do servidor. Faça o pull antes."

if [ "$BUMP" != "current" ]; then
  npm version "$BUMP" --no-git-tag-version >/dev/null
  # se algo falhar antes do commit da versão, o número volta ao que era
  trap 'git checkout --quiet package.json package-lock.json; echo "Versão revertida." >&2' ERR
fi
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
if gh release view "$TAG" -R "$REPO" --json isDraft -q .isDraft 2>/dev/null | grep -q false; then
  fail "A versão $VERSION já foi publicada."
fi
echo "Versão: $VERSION"

# texto do release: o que entrou desde a versão anterior (dá para editar depois no GitHub)
PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
NOTES="$(mktemp)"
git log --no-merges --format='- %s' ${PREV:+"$PREV"..}HEAD | grep -v '^- chore: versão' > "$NOTES" || true
[ -s "$NOTES" ] || echo "- Melhorias e correções" > "$NOTES"

step "Testes"
npm run typecheck
npm test

# o rascunho existe antes do envio e só sai de rascunho no fim: quem já tem o app instalado não vê a versão antes
gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 \
  || gh release create "$TAG" -R "$REPO" --draft --title "$VERSION" --notes-file "$NOTES" >/dev/null

step "Compilando, assinando e notarizando (a notarização leva alguns minutos; o helper de voz compila na primeira vez)"
APPLE_KEYCHAIN_PROFILE="$PROFILE" GH_TOKEN="$(gh auth token)" npm run release:mac

step "Conferindo o app empacotado"
npm run dist:check

step "Gravando a versão no Git"
if [ "$BUMP" != "current" ]; then
  git commit --quiet -m "chore: versão $VERSION" package.json package-lock.json
  trap - ERR
fi
git tag "$TAG"
git push --quiet origin main "$TAG"

step "Liberando para os usuários"
gh release edit "$TAG" -R "$REPO" --draft=false --latest --notes-file "$NOTES" >/dev/null

echo
echo "✓ ScreenRx $VERSION publicado: https://github.com/$REPO/releases/tag/$TAG"
