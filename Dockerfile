# O editor web do ScreenRx: a página (out/web) e o servidor Node que a serve
# e transcreve a fala por um serviço compatível com a API de áudio da OpenAI.
# Veja docs/ARCHITECTURE.md, "Editor web (navegador)", e docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Só a página e o servidor são construídos: nada do Electron é baixado.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.web.json tsconfig.node.json vite.web.config.ts vite.server.config.ts ./
COPY src ./src
RUN npm run build:web && npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/out/web ./out/web
COPY --from=build /app/out/server ./out/server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "out/server/index.mjs"]
