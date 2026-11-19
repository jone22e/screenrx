import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * The web editor's server (src/server), bundled into one Node module:
 * `npm run build:server` writes out/server/index.mjs; `npm run start:server`
 * runs it. It has no dependencies of its own beyond Node.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/engine')
    }
  },
  ssr: { noExternal: true },
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: resolve(__dirname, 'out/server'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } }
  }
})
