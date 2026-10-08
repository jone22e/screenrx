# Atalhos de linha de comando. Os passos em si são os scripts do package.json e do scripts/release.sh.
#
#   make update        sobe a versão (0.1.0 -> 0.1.1) e publica; os apps instalados se atualizam sozinhos
#   make build-mac     gera o instalador local (release/ScreenRx-<versão>-arm64.dmg), sem publicar
#   make check         confere o app empacotado
#   make install       abre o DMG gerado
#
# Ver docs/RELEASE.md.

SHELL := /bin/zsh
NPM ?= npm
VERSION_NOW := $(shell node -p "require('./package.json').version")
DMG := release/ScreenRx-$(VERSION_NOW)-arm64.dmg

.PHONY: help update update-minor update-major release build-mac check install

help:
	@echo "make update         sobe a versão (0.1.0 -> 0.1.1) e publica"
	@echo "make update-minor   sobe a versão (0.1.3 -> 0.2.0) e publica"
	@echo "make update-major   sobe a versão (0.2.1 -> 1.0.0) e publica"
	@echo "make update VERSION=1.4.0   publica com um número escolhido"
	@echo "make release        publica a versão que já está no package.json"
	@echo "make build-mac      gera o instalador local em $(DMG), sem publicar"
	@echo "make check          testa o app empacotado (após make build-mac)"
	@echo "make install        abre o DMG gerado"

update:
	@scripts/release.sh $(or $(VERSION),patch)

update-minor:
	@scripts/release.sh minor

update-major:
	@scripts/release.sh major

release:
	@scripts/release.sh current

# Build de produção, helpers nativos, helper de voz e empacotamento com assinatura local (ad hoc).
build-mac:
	$(NPM) run dist
	@echo
	@echo "Instalador gerado: $(CURDIR)/$(DMG)"
	@ls -lh "$(DMG)" | awk '{ print "Tamanho: " $$5 }'

check:
	$(NPM) run dist:check

install: $(DMG)
	open "$(DMG)"
