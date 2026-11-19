import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

/**
 * Serves the built page: hashed assets for a year, everything else checked
 * on each visit, and the page itself for any address without a file
 * extension, so a reload inside the editor still lands on it.
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

/** Where a request's path lands inside `webDir`, or `null` when it would leave it. */
export function resolveStaticPath(webDir: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const relative = path.posix.normalize(decoded).replace(/^\/+/, '')
  const resolved = path.resolve(webDir, relative)
  const root = path.resolve(webDir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

export async function serveStatic(webDir: string, request: IncomingMessage, response: ServerResponse, urlPath: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  let filePath = resolveStaticPath(webDir, urlPath === '/' ? '/index.html' : urlPath)
  if (!filePath) {
    response.writeHead(400).end()
    return
  }
  let info = await stat(filePath).catch(() => null)
  if (info?.isDirectory()) {
    filePath = path.join(filePath, 'index.html')
    info = await stat(filePath).catch(() => null)
  }
  if (!info?.isFile()) {
    // An address inside the app, not a file: the page takes it from there.
    if (path.extname(urlPath) === '') {
      filePath = path.join(webDir, 'index.html')
      info = await stat(filePath).catch(() => null)
    }
    if (!info?.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
  }
  const extension = path.extname(filePath).toLowerCase()
  const hashed = /\/assets\//.test(filePath.replace(/\\/g, '/')) && extension !== '.html'
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(filePath).pipe(response)
}
