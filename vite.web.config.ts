import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

/**
 * The web editor: the same renderer code as the desktop app, served as a
 * page, with its own bridge in place of the preload's (src/web/main.tsx).
 * `npm run dev:web` serves it; `npm run build:web` writes it to out/web.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'screenrx:web-content-security-policy',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const dev = context.server !== undefined
        const policy = [
          "default-src 'none'",
          `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
          `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
          // The video, the images and the music are files the user opened, read as blobs.
          "img-src 'self' data: blob:",
          'media-src blob:',
          "font-src 'self'",
          `connect-src 'self' blob:${dev ? ' ws:' : ''}`
        ].join('; ')
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }]
      }
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  publicDir: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/engine')
    }
  },
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: 5180,
    strictPort: true,
    fs: { allow: [resolve(__dirname, 'src'), resolve(__dirname, 'node_modules')] },
    // The transcription API comes from the server (npm run start:server) while the page is served here.
    proxy: { '/api': { target: process.env.SCREENRX_API_URL ?? 'http://localhost:8080', changeOrigin: true } }
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    target: 'es2022'
  }
})
