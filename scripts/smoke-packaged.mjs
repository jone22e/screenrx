// Smoke test of the packaged app (`npm run dist` first): starts
// release/mac-arm64/ScreenRx.app and checks that what only exists in a
// package works — the native helpers under Resources/native and the FFmpeg
// binaries unpacked from the archive.
//
// It reads the real library but changes nothing in it, and uses a throwaway
// profile, so it can run next to a development app.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = join(projectRoot, 'release', 'mac-arm64', 'ScreenRx.app')
const resources = join(appPath, 'Contents', 'Resources')

const checks = []
function check(name, passed, detail = '') {
  checks.push(passed)
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const runs = (binary, args) => {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 })
  return { ok: result.status === 0, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

if (!existsSync(appPath)) {
  console.log(`No packaged app at ${appPath}: run "npm run dist" first.`)
  process.exit(2)
}

const signature = runs('codesign', ['--verify', '--deep', '--strict', appPath])
check('the bundle and everything in it is signed consistently', signature.ok, signature.text)

// What the installed app reads to know where to look for updates.
const updateConfig = join(resources, 'app-update.yml')
check(
  'the app knows where to look for updates',
  existsSync(updateConfig) && /repo: screenrx/.test(readFileSync(updateConfig, 'utf8')),
  existsSync(updateConfig) ? 'app-update.yml' : 'app-update.yml is missing'
)

const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
const ffmpeg = runs(join(unpacked, 'ffmpeg-static', 'ffmpeg'), ['-version'])
check('the bundled FFmpeg runs from outside the archive', ffmpeg.ok, ffmpeg.text.split('\n')[0])
const ffprobePath = join(unpacked, '@ffprobe-installer', 'darwin-arm64', 'ffprobe')
const ffprobe = runs(ffprobePath, ['-version'])
check('the bundled FFprobe runs from outside the archive', ffprobe.ok, ffprobe.text.split('\n')[0])
const transcriber = runs(join(resources, 'native', 'screenrx-transcribe'), ['--input', '/nonexistent.m4a', '--locale', 'pt-BR'])
// A binary for another processor would only run where Rosetta happens to be installed.
const architectures = runs('file', [
  join(unpacked, 'ffmpeg-static', 'ffmpeg'),
  ffprobePath,
  join(resources, 'native', 'screenrx-capture'),
  join(resources, 'native', 'screenrx-transcribe'),
  join(resources, 'native', 'screenrx-dub')
])
check(
  'every bundled executable is native to Apple Silicon',
  architectures.ok && architectures.text.split('\n').every((line) => line.includes('arm64')),
  architectures.text.split('\n').map((line) => line.split(' ').pop()).join(', ')
)
// Asked to synthesize without a model, the voice helper must answer that the model is missing:
// that it answers at all means it found its shader library and its own libraries.
const voice = runs(join(resources, 'native', 'screenrx-dub'), [
  'synthesize', '--models', join(tmpdir(), 'screenrx-smoke-no-models'), '--reference', '/dev/null',
  '--reference-text', '/dev/null', '--language', 'en', '--jobs', '/dev/null'
])
check(
  'the bundled voice helper starts, with its shader library beside it',
  /"bad-arguments"|"model-missing"/.test(voice.text) && existsSync(join(resources, 'native', 'mlx.metallib')),
  voice.text.split('\n').pop()
)
check('the bundled transcriber starts and answers', /"unreadable-audio"|"unsupported-os"/.test(transcriber.text), transcriber.text.split('\n').pop())

const profile = mkdtempSync(join(tmpdir(), 'screenrx-smoke-'))
const app = await electron.launch({
  executablePath: join(appPath, 'Contents', 'MacOS', 'ScreenRx'),
  args: [`--user-data-dir=${profile}`]
})
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.home', { timeout: 20_000 })
  const info = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    version: electronApp.getVersion(),
    name: electronApp.getName()
  }))
  check('the packaged app opens on the library', info.packaged, `${info.name} ${info.version}`)

  const permissions = await page.evaluate(() => window.screenrx.permissions.get())
  check(
    'the capture helper inside the bundle answers',
    permissions.ok,
    permissions.ok ? JSON.stringify(permissions.value.permissions) : permissions.error.detail
  )

  const tools = await page.evaluate(() => window.screenrx.ai.providers(true))
  const dub = await page.evaluate(() => window.screenrx.dub.status())
  check('dubbing is available in the packaged app', dub.available === true, `voice model: ${dub.model}`)

  check(
    'the AI tools installed on this Mac are found from the packaged app',
    tools.length === 3,
    tools.map((tool) => `${tool.id}: ${tool.installed ? (tool.loggedIn ? 'ready' : 'signed out') : 'missing'}`).join(', ')
  )

  const library = await page.evaluate(() => window.screenrx.library.list())
  const withAudio = library.find((recording) => recording.status === 'completed')
  if (!withAudio) {
    console.log('INFO  the library is empty: poster and waveform were not exercised')
  } else {
    // Both are made by the bundled FFmpeg; neither writes to the recording.
    const poster = await page.evaluate(
      (url) =>
        new Promise((resolvePoster) => {
          const image = document.createElement('img')
          image.onload = () => resolvePoster(image.naturalWidth)
          image.onerror = () => resolvePoster(0)
          image.src = url
        }),
      withAudio.thumbnailUrl
    )
    check('a poster frame is extracted with the bundled FFmpeg', poster > 0, `${poster} px wide`)
  }
} finally {
  await app.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = checks.filter((passed) => !passed).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
