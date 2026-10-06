import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@engine': resolve(__dirname, 'src/engine')
}

/**
 * Injects the Content-Security-Policy into every renderer page. Production
 * pages may only load the app's own bundled code; the dev server additionally
 * needs inline scripts/styles and a websocket for hot reload.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'screenrx:content-security-policy',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const dev = context.server !== undefined
        const policy = [
          "default-src 'none'",
          `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
          `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
          // Poster frames of the recordings come from the media scheme too.
          "img-src 'self' data: screenrx-media:",
          // Recorded media is streamed by the main process (src/main/media).
          'media-src screenrx-media:',
          "font-src 'self'",
          `connect-src ${dev ? "'self' ws:" : "'none'"}`
        ].join('; ')
        return [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend'
          }
        ]
      }
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Only the meeting window loads this one.
          meet: resolve(__dirname, 'src/preload/meet.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          hud: resolve(__dirname, 'src/renderer/hud.html'),
          camera: resolve(__dirname, 'src/renderer/camera.html')
        }
      }
    }
  }
})
