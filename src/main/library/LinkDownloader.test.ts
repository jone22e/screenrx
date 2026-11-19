import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LinkDownloadProgress } from '@shared/models/link'
import { normalizeVideoLink } from '@shared/models/link'
import type { Logger } from '../logging/logger'
import { FfmpegService, bundledFfmpegBinaries } from '../export/FfmpegService'
import { SessionStore } from '../recording/SessionStore'
import { LinkDownloader, downloadError } from './LinkDownloader'
import { VideoImporter } from './VideoImporter'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('LinkDownloader', { timeout: 30_000 }, () => {
  const binaries = bundledFfmpegBinaries()
  let directory: string
  let sessions: SessionStore
  let progress: LinkDownloadProgress[]
  let fixture: string

  /** A stand-in for yt-dlp that speaks its output lines and "downloads" the fixture into the `-o` folder. */
  const fakeTool = async (exitCode = 0, stderr = ''): Promise<string> => {
    const bin = path.join(directory, 'bin')
    await mkdir(bin, { recursive: true })
    const script = path.join(bin, 'yt-dlp')
    await writeFile(
      script,
      `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
dir=$(dirname "$out")
echo "SRX_TITLE Minha aula de teste"
echo "SRX_PROGRESS  42.0%"
echo "SRX_PROGRESS 100.0%"
echo "SRX_PROGRESS   3.0%"
if [ ${exitCode} -ne 0 ]; then echo "${stderr}" >&2; exit ${exitCode}; fi
cp "${fixture}" "$dir/abc123.mp4"
echo "SRX_FILE $dir/abc123.mp4"
`
    )
    await chmod(script, 0o755)
    return script
  }

  const downloader = (systemTool: string | null, fetcher?: (url: string) => Promise<Response>) =>
    new LinkDownloader({
      ...(fetcher && { fetcher }),
      toolsDirectory: path.join(directory, 'tools'),
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
      importer: new VideoImporter({ ffmpeg: new FfmpegService(binaries, silentLogger), sessions, logger: silentLogger }),
      sessions,
      logger: silentLogger,
      onProgress: (entry) => progress.push(entry),
      systemCandidates: systemTool ? [systemTool] : []
    })

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'screenrx-link-test-'))
    sessions = new SessionStore(path.join(directory, 'recordings'), silentLogger)
    progress = []
    fixture = path.join(directory, 'fixture.mp4')
    const result = spawnSync(
      binaries.ffmpeg,
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture],
      { encoding: 'utf8' }
    )
    if (result.status !== 0) throw new Error(result.stderr)
  }, 30_000)

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('downloads the video behind a link and imports it with the site’s title', async () => {
    const links = downloader(await fakeTool())
    const sessionId = await links.download('youtube.com/watch?v=abc123')
    const manifest = await sessions.read(sessionId)
    expect(manifest?.title).toBe('Minha aula de teste')
    expect(manifest?.sourceUrl).toBe('https://youtube.com/watch?v=abc123')
    expect(manifest?.assets.screen?.durationMs).toBeGreaterThan(1500)
    expect(manifest?.assets.microphone).toBeDefined()
    const fractions = progress.filter((entry) => entry.stage === 'downloading').map((entry) => entry.fraction)
    // The second part (the audio) starts over at 0 %, but the bar does not go back.
    expect(fractions).toEqual([0.42 * 0.85, 0.85, 0.85 + 0.03 * 0.15].map((value) => expect.closeTo(value, 5)))
    expect(progress.at(-1)?.stage).toBe('done')
  })

  it('says why a download failed, and refuses what is not a link', async () => {
    const links = downloader(await fakeTool(1, 'ERROR: [youtube] abc: Private video. Sign in if you have been granted access'))
    await expect(links.download('https://youtu.be/abc')).rejects.toMatchObject({ appError: { code: 'link-download-failed', message: expect.stringContaining('privado') } })
    await expect(links.download('file:///etc/passwd')).rejects.toMatchObject({ appError: { code: 'link-invalid' } })
    expect(await sessions.list()).toEqual([])
  })

  it('asks for the tool when there is none, and installs it checked against the release sums', async () => {
    const binary = new TextEncoder().encode('#!/bin/sh\necho yt-dlp\n')
    const sum = createHash('sha256').update(binary).digest('hex')
    const asset = process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux'
    const fetcher = async (url: string): Promise<Response> => {
      if (url.includes('api.github.com'))
        return new Response(
          JSON.stringify({
            tag_name: '2026.10.26',
            assets: [
              { name: asset, size: binary.byteLength, browser_download_url: 'https://example.test/bin' },
              { name: 'SHA2-256SUMS', size: 10, browser_download_url: 'https://example.test/sums' }
            ]
          })
        )
      if (url.endsWith('/sums')) return new Response(`${sum}  ${asset}\nffff  other\n`)
      return new Response(binary)
    }
    const links = downloader(null, fetcher)
    expect(await links.status()).toEqual({ installed: false, source: null, downloadBytes: binary.byteLength, version: '2026.10.26' })
    await expect(links.download('https://youtu.be/x')).rejects.toMatchObject({ appError: { code: 'link-tool-missing' } })
    expect((await links.installTool()).installed).toBe(true)
    expect((await links.toolPath())?.source).toBe('app')
  })
})

describe('normalizeVideoLink', () => {
  it('takes web addresses only', () => {
    expect(normalizeVideoLink(' https://www.youtube.com/watch?v=x ')).toBe('https://www.youtube.com/watch?v=x')
    expect(normalizeVideoLink('youtu.be/abc')).toBe('https://youtu.be/abc')
    expect(normalizeVideoLink('javascript:alert(1)')).toBeNull()
    expect(normalizeVideoLink('localhost')).toBeNull()
    expect(normalizeVideoLink('')).toBeNull()
  })
})

describe('downloadError', () => {
  it('turns yt-dlp’s last error into words', () => {
    expect(downloadError('WARNING: x\nERROR: Unsupported URL: https://a.b').message).toContain('não é suportado')
    expect(downloadError('ERROR: Video unavailable').message).toContain('não está disponível')
  })
})
