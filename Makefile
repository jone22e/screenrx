# Atalhos de linha de comando. Os passos em si são os scripts do package.json.
#
#   make update   gera o instalador (release/ScreenRx-<versão>-arm64.dmg)
#   make check    confere o app empacotado
#   make install  abre o DMG gerado

SHELL := /bin/zsh
NPM ?= npm
VERSION := $(shell node -p "require('./package.json').version")
DMG := release/ScreenRx-$(VERSION)-arm64.dmg

.PHONY: update check install help

help:
	@echo "make update   gera o instalador em $(DMG)"
	@echo "make check    testa o app empacotado (após make update)"
	@echo "make install  abre o DMG gerado"

# Build de produção, helpers nativos, helper de voz e empacotamento com assinatura local.
update:
	$(NPM) run dist
	@echo
	@echo "Instalador gerado: $(CURDIR)/$(DMG)"
	@ls -lh "$(DMG)" | awk '{ print "Tamanho: " $$5 }'

check:
	$(NPM) run dist:check

install: $(DMG)
	open "$(DMG)"
