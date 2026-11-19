import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppError } from '@shared/models/errors'
import { appError } from '@shared/models/errors'
import type { LinkDownloadProgress, LinkToolStatus } from '@shared/models/link'
import { normalizeVideoLink } from '@shared/models/link'
import { normalizeSessionTitle } from '@shared/models/session'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import type { VideoImporter } from './VideoImporter'

export class LinkError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'LinkError'
  }
}

export interface LinkDownloaderDeps {
  /** Where the app keeps the tool it downloads (`userData/tools`). */
  toolsDirectory: string
  ffmpegPath: string
  ffprobePath: string
  importer: VideoImporter
  sessions: SessionStore
  logger: Logger
  onProgress: (progress: LinkDownloadProgress) => void
  /** Installed elsewhere (Homebrew), used as it is when present. */
  systemCandidates?: string[]
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
}

const RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const ASSET_NAME = process.platform === 'darwin' ? 'yt-dlp_macos' : process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux'
const TOOL_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const SYSTEM_CANDIDATES = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']

/** H.264 with AAC first, as the editor reads it without converting; then the best there is. */
const FORMAT = 'bv*[vcodec^=avc1][height<=2160]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*[height<=2160]+ba/b'

/**
 * Brings a video from a link (YouTube, Instagram, Vimeo…) into the library,
 * with yt-dlp: downloaded once from inside the app when the user asks (its
 * size is told first), or the copy already installed with Homebrew. The
 * file it fetches is imported as any video is, then removed.
 */
export class LinkDownloader {
  private child: ChildProcess | null = null
  private cancelled = false

  constructor(private readonly deps: LinkDownloaderDeps) {}

  private get ownTool(): string {
    return path.join(this.deps.toolsDirectory, TOOL_NAME)
  }

  /** The tool the app would use, or `null` when there is none yet. */
  async toolPath(): Promise<{ path: string; source: 'app' | 'system' } | null> {
    if (await isExecutable(this.ownTool)) return { path: this.ownTool, source: 'app' }
    for (const candidate of this.deps.systemCandidates ?? SYSTEM_CANDIDATES) {
      if (await isExecutable(candidate)) return { path: candidate, source: 'system' }
    }
    return null
  }

  /** Whether the tool is there and, when not, how big the download is (asked to GitHub, not guessed). */
  async status(): Promise<LinkToolStatus> {
    const found = await this.toolPath()
    if (found) return { installed: true, source: found.source, downloadBytes: null, version: null }
    const asset = await this.latestAsset().catch(() => null)
    return { installed: false, source: null, downloadBytes: asset?.size ?? null, version: asset?.version ?? null }
  }

  /** Downloads yt-dlp into the app's data, checked against the release's SHA-256 list. */
  async installTool(): Promise<LinkToolStatus> {
    const { logger, toolsDirectory } = this.deps
    const fetcher = this.deps.fetcher ?? fetch
    try {
      const asset = await this.latestAsset()
      await mkdir(toolsDirectory, { recursive: true })
      const response = await fetcher(asset.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const sums = await fetcher(asset.sumsUrl).then((answer) => (answer.ok ? answer.text() : ''))
      const expected = sums
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === ASSET_NAME)?.[0]
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (!expected || expected.toLowerCase() !== actual) throw new Error(`checksum mismatch (expected ${expected ?? 'none'})`)
      const partial = `${this.ownTool}.part`
      await writeFile(partial, bytes)
      await chmod(partial, 0o755)
      await rename(partial, this.ownTool)
      logger.info('yt-dlp installed', { version: asset.version, bytes: bytes.byteLength })
      return this.status()
    } catch (error) {
      logger.error('yt-dlp install failed', { error: String(error) })
      throw new LinkError(appError('link-tool-failed', String(error)))
    }
  }

  /** Downloads the video behind the link and imports it; the new recording's id. */
  async download(link: string): Promise<string> {
    const { importer, sessions, logger, onProgress } = this.deps
    const url = normalizeVideoLink(link)
    if (!url) throw new LinkError(appError('link-invalid'))
    if (this.child) throw new LinkError(appError('invalid-state', 'a download is under way'))
    const tool = await this.toolPath()
    if (!tool) throw new LinkError(appError('link-tool-missing'))

    this.cancelled = false
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'screenrx-link-'))
    try {
      onProgress({ url, stage: 'starting', fraction: null, title: null })
      const { filePath, title } = await this.run(tool.path, url, workDir, await this.ffmpegDirectory())
      onProgress({ url, stage: 'importing', fraction: null, title })
      const sessionId = await importer.import(filePath)
      const manifest = await sessions.read(sessionId)
      if (manifest) {
        const named = normalizeSessionTitle(title)
        await sessions.write({ ...manifest, ...(named && { title: named }), sourceUrl: url })
      }
      logger.info('video downloaded by link', { sessionId, host: new URL(url).host })
      onProgress({ url, stage: 'done', fraction: 1, title })
      return sessionId
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  /** yt-dlp finds FFmpeg and FFprobe side by side in one folder; the bundled ones live apart, so they are linked into one. */
  private async ffmpegDirectory(): Promise<string> {
    const directory = path.join(this.deps.toolsDirectory, 'ffmpeg-bin')
    await mkdir(directory, { recursive: true })
    for (const [name, target] of [
      ['ffmpeg', this.deps.ffmpegPath],
      ['ffprobe', this.deps.ffprobePath]
    ] as const) {
      const link = path.join(directory, name)
      await rm(link, { force: true })
      await symlink(target, link)
    }
    return directory
  }

  cancel(): void {
    if (!this.child) return
    this.cancelled = true
    this.child.kill('SIGTERM')
  }

  private run(tool: string, url: string, workDir: string, ffmpegLocation: string): Promise<{ filePath: string; title: string | null }> {
    const { logger, onProgress } = this.deps
    const args = [
      '--no-playlist',
      '--no-mtime',
      '--restrict-filenames',
      '--no-part',
      '-f', FORMAT,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegLocation,
      '-o', path.join(workDir, '%(id)s.%(ext)s'),
      '--print', 'before_dl:SRX_TITLE %(title)s',
      '--print', 'after_move:SRX_FILE %(filepath)s',
      '--progress',
      '--newline',
      '--progress-template', 'download:SRX_PROGRESS %(progress._percent_str)s',
      '--', url
    ]
    return new Promise((resolve, reject) => {
      const child = spawn(tool, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let title: string | null = null
      let filePath: string | null = null
      let stderr = ''
      let buffered = ''
      // Each part (video, then audio) goes from 0 to 100 %; the second one counts for less.
      let part = 0
      let lastPercent = 0
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('SRX_TITLE ')) title = line.slice(10).trim() || null
          else if (line.startsWith('SRX_FILE ')) filePath = line.slice(9).trim()
          else if (line.startsWith('SRX_PROGRESS ')) {
            const percent = Number.parseFloat(line.slice(13))
            if (!Number.isFinite(percent)) continue
            if (percent + 5 < lastPercent) part++
            lastPercent = percent
            const fraction = part === 0 ? (percent / 100) * 0.85 : 0.85 + (percent / 100) * 0.15
            onProgress({ url, stage: 'downloading', fraction: Math.min(fraction, 1), title })
          }
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000)
      })
      child.on('error', (error) => {
        this.child = null
        reject(new LinkError(appError('link-download-failed', String(error))))
      })
      child.on('close', (code) => {
        this.child = null
        if (this.cancelled) return reject(new LinkError(appError('link-cancelled')))
        void (async () => {
          const found = filePath ?? (await readdir(workDir).then((names) => names.find((name) => name.endsWith('.mp4') || name.endsWith('.mkv') || name.endsWith('.webm'))).then((name) => (name ? path.join(workDir, name) : null)))
          if (code === 0 && found) return resolve({ filePath: found, title })
          logger.error('yt-dlp failed', { code, stderr: stderr.slice(-1500) })
          reject(new LinkError(downloadError(stderr)))
        })()
      })
    })
  }

  private async latestAsset(): Promise<{ url: string; sumsUrl: string; size: number; version: string }> {
    const fetcher = this.deps.fetcher ?? fetch
    const response = await fetcher(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ScreenRx' } })
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
    const release = (await response.json()) as { tag_name?: string; assets?: Array<{ name: string; size: number; browser_download_url: string }> }
    const asset = release.assets?.find((entry) => entry.name === ASSET_NAME)
    const sums = release.assets?.find((entry) => entry.name === 'SHA2-256SUMS')
    if (!asset || !sums) throw new Error('release has no asset for this platform')
    return { url: asset.browser_download_url, sumsUrl: sums.browser_download_url, size: asset.size, version: release.tag_name ?? '' }
  }
}

/** yt-dlp's last error line, turned into something the user can act on. */
export function downloadError(stderr: string): AppError {
  const last = stderr.split('\n').reverse().find((line) => line.includes('ERROR:')) ?? stderr.trim().split('\n').at(-1) ?? ''
  const failed = appError('link-download-failed', last.slice(0, 500))
  if (/private video|sign in to confirm|login required|members-only/i.test(last)) return { ...failed, message: `${failed.message} O vídeo é privado ou pede login.` }
  if (/unsupported url/i.test(last)) return { ...failed, message: `${failed.message} Esse site não é suportado.` }
  if (/not available|removed|unavailable/i.test(last)) return { ...failed, message: `${failed.message} O vídeo não está disponível.` }
  return failed
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}
