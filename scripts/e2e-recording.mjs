// End-to-end check of phase 1, driving the real app and the real capture:
//
//   1. the app boots on the library; "Nova gravação" swaps it for the recording bar
//   2. record -> pause -> resume -> stop produces a valid MP4 and session.json
//   3. the paused span is absent from the file
//   4. the HUD stays on screen but is NOT in the recording
//
// Step 4 is verified against a control: a plain system screenshot taken
// while idle must show the HUD (proving the comparison can see it); the
// app's own recording must not.
//
// Requires: `npm run build`, Screen Recording permission for the launching
// terminal, and ffmpeg/ffprobe on PATH (dev-only dependency of this script).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = mkdtempSync(join(tmpdir(), 'screenrx-e2e-'))
const recordingsDir = join(workDir, 'recordings')
const exportsDir = join(workDir, 'exports')
const keepArtifacts = process.argv.includes('--keep')

const RECORD_BEFORE_PAUSE_MS = 2500
const PAUSE_MS = 2000
const RECORD_AFTER_RESUME_MS = 1500
const DURATION_TOLERANCE_MS = 700
/**
 * Mean absolute pixel difference (0-255) between what a capture shows where
 * the HUD sits and the HUD's own rendering: near zero when the HUD is in the
 * capture, large when the desktop behind it is. Values in between are
 * inconclusive and fail both kinds of check.
 */
const HUD_PRESENT_BELOW = 6
const HUD_ABSENT_ABOVE = 12
/** The HUD bar is compared away from its rounded corners. */
const HUD_INSET_PT = 14

const checks = []
function check(name, passed, detail = '') {
  checks.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function note(name, detail) {
  console.log(`INFO  ${name}  (${detail})`)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Raw frames are large.
    maxBuffer: 512 * 1024 * 1024
  })
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.stderr.toString('utf8').slice(-400)
    throw new Error(`${command} failed: ${reason}`)
  }
  return result.stdout
}

/** App windows are not drawn while the screen is locked, so nothing here could be verified. */
function isScreenLocked() {
  const session = run('ioreg', ['-n', 'Root', '-d1', '-a']).toString('utf8')
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(session)
}

function probe(mediaPath) {
  const output = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_frames:format=duration',
    '-of', 'json', mediaPath
  ])
  const parsed = JSON.parse(output.toString('utf8'))
  return { ...parsed.streams[0], durationMs: Number(parsed.format.duration) * 1000 }
}

/**
 * Raw RGB pixels of the HUD's interior as seen in `mediaPath` — a video
 * (at `timeSec`) or a still of the whole display.
 */
function hudRegionOf(mediaPath, hudBounds, displayBounds, timeSec = null) {
  const scale = probe(mediaPath).width / displayBounds.width
  const rect = {
    x: Math.round((hudBounds.x - displayBounds.x + HUD_INSET_PT) * scale),
    y: Math.round((hudBounds.y - displayBounds.y + HUD_INSET_PT) * scale),
    width: Math.round((hudBounds.width - 2 * HUD_INSET_PT) * scale),
    height: Math.round((hudBounds.height - 2 * HUD_INSET_PT) * scale)
  }
  const pixels = run('ffmpeg', [
    '-v', 'error', ...(timeSec === null ? [] : ['-ss', String(timeSec)]), '-i', mediaPath,
    '-frames:v', '1', '-vf', `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ])
  return { pixels, rect }
}

/** The same interior region taken from a screenshot of the HUD page itself. */
function hudRegionOfPage(pngPath, hudBounds, size) {
  const scale = size.width / (hudBounds.width - 2 * HUD_INSET_PT)
  const inset = Math.round(HUD_INSET_PT * scale)
  return run('ffmpeg', [
    '-v', 'error', '-i', pngPath,
    '-vf', `scale=${Math.round(hudBounds.width * scale)}:${Math.round(hudBounds.height * scale)},crop=${size.width}:${size.height}:${inset}:${inset}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ])
}

function meanAbsoluteDifference(a, b) {
  if (a.length !== b.length || a.length === 0) throw new Error('crops differ in size')
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

/** How different the HUD region of `mediaPath` is from the HUD's own rendering. */
function hudDifference(mediaPath, pagePng, hudBounds, displayBounds, timeSec = null) {
  const seen = hudRegionOf(mediaPath, hudBounds, displayBounds, timeSec)
  return meanAbsoluteDifference(seen.pixels, hudRegionOfPage(pagePng, hudBounds, seen.rect))
}

const hudBoundsScript = ({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()
    .find((window) => window.webContents.getURL().endsWith('hud.html'))
    .getBounds()

async function main() {
  // A private copy of the capture helper: macOS allows one capture client per
  // executable, and a development app may already be running the original.
  const helperCopy = join(workDir, 'screenrx-capture')
  copyFileSync(join(projectRoot, 'dist-native', 'darwin', 'screenrx-capture'), helperCopy)
  mkdirSync(exportsDir)

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${join(workDir, 'user-data')}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      SCREENRX_RECORDINGS_DIR: recordingsDir,
      SCREENRX_HELPER_PATH: helperCopy,
      SCREENRX_EXPORT_DIR: exportsDir
    }
  })

  try {
    // --- boot -------------------------------------------------------------
    const pageNamed = async (name) => {
      const deadline = Date.now() + 15_000
      for (;;) {
        const page = app.windows().find((candidate) => candidate.url().endsWith(name))
        if (page || Date.now() > deadline) return page
        await sleep(100)
      }
    }
    const windowStates = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          page: window.webContents.getURL().split('/').pop(),
          visible: window.isVisible(),
          protected: window.isContentProtected(),
          alwaysOnTop: window.isAlwaysOnTop()
        }))
      )

    const mainPage = await pageNamed('index.html')
    check('the main window is created', Boolean(mainPage))
    if (!mainPage) return
    await mainPage.waitForSelector('.home')
    const atStartup = await windowStates()
    check(
      'the app opens on the library, without the recording bar',
      atStartup.filter((window) => window.visible).map((window) => window.page).join(',') === 'index.html',
      JSON.stringify(atStartup.map(({ page, visible }) => ({ page, visible })))
    )

    const isolation = await mainPage.evaluate(() => ({
      hasBridge: typeof window.screenrx === 'object',
      hasRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      bridgeKeys: Object.keys(window.screenrx).sort().join(',')
    }))
    check(
      'renderer is isolated and only sees the explicit bridge',
      isolation.hasBridge && !isolation.hasRequire && !isolation.hasProcess,
      isolation.bridgeKeys
    )

    const permissions = await mainPage.evaluate(() => window.screenrx.permissions.get())
    const granted = permissions.ok && permissions.value.permissions.screenRecording === 'granted'
    check('screen recording permission is granted', granted)
    if (!granted) {
      const grantee = permissions.ok ? permissions.value.grantee.name : null
      console.log(`Enable Screen Recording for ${grantee ?? 'the app that launched this script'} and run again.`)
      return
    }

    let initial = await mainPage.evaluate(() => window.screenrx.recording.getState())
    for (let attempt = 0; attempt < 50 && !initial.selectedSource; attempt++) {
      await sleep(100)
      initial = await mainPage.evaluate(() => window.screenrx.recording.getState())
    }
    check('main display is preselected', initial.selectedSource?.kind === 'display', initial.selectedSource?.label)
    if (!initial.selectedSource) return

    // The main window is the library; what to record is chosen in the bar only.
    await mainPage.waitForSelector('.home')
    const emptyLibrary = await mainPage.locator('.empty-state').waitFor({ timeout: 5000 }).then(() => true, () => false)
    check(
      'the home screen is an empty library, with no source picker',
      emptyLibrary && (await mainPage.locator('.source-card, .devices').count()) === 0
    )

    // "Nova gravação" switches to recording mode: the library hides, the bar appears.
    await mainPage.getByRole('button', { name: 'Nova gravação' }).first().click()
    const hud = await pageNamed('hud.html')
    check('the recording bar window is created on demand', Boolean(hud))
    if (!hud) return
    await hud.waitForSelector('.hud')
    await sleep(400)
    const inRecorder = await windowStates()
    check(
      '"Nova gravação" hides the library and shows the recording bar',
      inRecorder.find((window) => window.page === 'hud.html')?.visible === true &&
        inRecorder.find((window) => window.page === 'index.html')?.visible === false,
      JSON.stringify(inRecorder.map(({ page, visible }) => ({ page, visible })))
    )

    // Closing the bar returns to the library; opening it again brings it back.
    await hud.click('[aria-label="Fechar"]')
    await sleep(400)
    const closed = await windowStates()
    await mainPage.getByRole('button', { name: 'Nova gravação' }).first().click()
    await sleep(400)
    const reopened = await windowStates()
    const visiblePages = (states) => states.filter((window) => window.visible).map((window) => window.page).join(',')
    check(
      'closing the bar returns to the library, and it can be reopened',
      visiblePages(closed) === 'index.html' && visiblePages(reopened) === 'hud.html',
      `${visiblePages(closed)} → ${visiblePages(reopened)}`
    )

    const displayBounds = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds)

    // --- companion tracks -----------------------------------------------------
    // System audio needs no extra permission. The microphone and the camera are
    // only enabled when already authorized, so this script never raises a prompt.
    const media = permissions.value.permissions
    const devices = await hud.evaluate(() => window.screenrx.devices.list())
    check(
      'microphones and cameras are listed',
      devices.ok && Array.isArray(devices.value.microphones) && Array.isArray(devices.value.cameras),
      devices.ok ? `${devices.value.microphones.length} microphones, ${devices.value.cameras.length} cameras` : ''
    )
    const microphone = media.microphone === 'granted' ? devices.value?.microphones[0] : undefined
    const camera = media.camera === 'granted' ? devices.value?.cameras[0] : undefined
    await hud.evaluate(() => window.screenrx.recording.setSystemAudio(true))
    if (microphone) await hud.evaluate((id) => window.screenrx.recording.setMicrophone(id), microphone.id)
    else note('microphone not authorized for this launcher', 'its track is not exercised')
    if (camera) await hud.evaluate((id) => window.screenrx.recording.setCamera(id), camera.id)
    else note('camera not authorized for this launcher', 'its track is not exercised')
    const options = (await hud.evaluate(() => window.screenrx.recording.getState())).options
    check(
      'companion tracks are enabled',
      options.systemAudio && Boolean(options.microphoneId) === Boolean(microphone) && Boolean(options.cameraId) === Boolean(camera),
      JSON.stringify({ microphone: options.microphoneName, systemAudio: options.systemAudio, camera: options.cameraName })
    )

    // --- control: while idle, a plain screenshot does show the HUD ------------
    const idleBounds = await app.evaluate(hudBoundsScript)
    const idlePage = join(workDir, 'hud-idle.png')
    const idleScreen = join(workDir, 'screen-idle.png')
    await hud.screenshot({ path: idlePage })
    run('screencapture', ['-x', '-m', idleScreen])
    const controlDiff = hudDifference(idleScreen, idlePage, idleBounds, displayBounds)
    check(
      'control: while idle the HUD is visible to a screen capture',
      controlDiff < HUD_PRESENT_BELOW,
      `difference ${controlDiff.toFixed(1)}`
    )

    // --- record -> pause -> resume -> stop ------------------------------------
    await hud.click('[aria-label="Gravar"]')
    await hud.waitForSelector('.hud-timer')
    const recording = await hud.evaluate(() => window.screenrx.recording.getState())
    check('recording starts', recording.phase === 'recording' && recording.clockRunning)

    const windowsWhileRecording = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        page: window.webContents.getURL().split('/').pop(),
        visible: window.isVisible(),
        protected: window.isContentProtected(),
        alwaysOnTop: window.isAlwaysOnTop()
      }))
    )
    const hudWindow = windowsWhileRecording.find((window) => window.page === 'hud.html')
    const mainWindow = windowsWhileRecording.find((window) => window.page === 'index.html')
    check(
      'HUD stays visible, on top and content-protected while recording',
      Boolean(hudWindow?.visible && hudWindow.alwaysOnTop && hudWindow.protected)
    )
    check('main window is hidden while recording', mainWindow?.visible === false)

    await sleep(RECORD_BEFORE_PAUSE_MS / 2)
    const recordingBounds = await app.evaluate(hudBoundsScript)
    const recordingPage = join(workDir, 'hud-recording.png')
    const recordingScreen = join(workDir, 'screen-recording.png')
    await hud.screenshot({ path: recordingPage })
    run('screencapture', ['-x', '-m', recordingScreen])
    await sleep(RECORD_BEFORE_PAUSE_MS / 2)

    await hud.click('[aria-label="Pausar"]')
    await hud.waitForSelector('[aria-label="Retomar"]')
    const pausedAt = await hud.evaluate(() => window.screenrx.recording.getState())
    await sleep(PAUSE_MS)
    const stillPaused = await hud.evaluate(() => window.screenrx.recording.getState())
    check(
      'pause freezes the recording clock',
      stillPaused.phase === 'paused' && stillPaused.elapsedMs === pausedAt.elapsedMs,
      `${Math.round(stillPaused.elapsedMs)} ms`
    )

    await hud.click('[aria-label="Retomar"]')
    await hud.waitForSelector('[aria-label="Pausar"]')
    await sleep(RECORD_AFTER_RESUME_MS)
    await hud.click('[aria-label="Finalizar"]')
    await hud.waitForSelector('[aria-label="Gravar"]', { timeout: 30_000 })
    const finished = await hud.evaluate(() => window.screenrx.recording.getState())
    check(
      'recording finishes without errors',
      finished.phase === 'idle' && finished.lastError === null && finished.lastCompletedSessionId !== null,
      finished.lastError?.code ?? finished.lastCompletedSessionId
    )
    if (!finished.lastCompletedSessionId) return

    // --- outputs --------------------------------------------------------------
    const sessionDir = join(recordingsDir, finished.lastCompletedSessionId)
    const screenPath = join(sessionDir, 'screen.mp4')

    // The finished recording opens straight in the editor, which creates its project.
    const editorOpened = await mainPage
      .waitForSelector('.timeline', { timeout: 15_000 })
      .then(() => true, () => false)
    check('the finished recording opens in the editor', editorOpened)
    const manifest = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'))
    const video = probe(screenPath)
    check(
      'screen.mp4 is a valid H.264 yuv420p MP4',
      video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && Number(video.nb_frames) > 0,
      `${video.width}x${video.height}, ${video.nb_frames} frames, ${Math.round(video.durationMs)} ms`
    )

    // The mid-recording screenshots cost some wall time too, so the upper
    // bound is loose; what matters is that the pause itself is not in there.
    const expectedMs = RECORD_BEFORE_PAUSE_MS + RECORD_AFTER_RESUME_MS
    check(
      'paused time is not in the video',
      video.durationMs > expectedMs - DURATION_TOLERANCE_MS &&
        video.durationMs < expectedMs + PAUSE_MS - DURATION_TOLERANCE_MS,
      `~${expectedMs} ms recorded + ${PAUSE_MS} ms paused -> ${Math.round(video.durationMs)} ms of video`
    )
    const pauses = manifest.clock.pauses.map((pause) => Math.round(pause.pausedForMs))
    check(
      'manifest is completed and agrees with the file',
      manifest.status === 'completed' &&
        Math.abs(manifest.clock.durationMs - video.durationMs) < 150 &&
        pauses.length === 1 &&
        Math.abs(pauses[0] - PAUSE_MS) < DURATION_TOLERANCE_MS,
      `clock ${Math.round(manifest.clock.durationMs)} ms, pauses ${JSON.stringify(pauses)}`
    )
    check(
      'no warnings in session diagnostics',
      manifest.diagnostics.every((diagnostic) => diagnostic.level !== 'warning'),
      JSON.stringify(manifest.diagnostics)
    )

    const recordedDiff = hudDifference(
      screenPath, recordingPage, recordingBounds, displayBounds, RECORD_BEFORE_PAUSE_MS / 2000
    )
    check(
      'the HUD is NOT in the recording',
      recordedDiff > HUD_ABSENT_ABOVE,
      `difference ${recordedDiff.toFixed(1)} vs ${controlDiff.toFixed(1)} in the control`
    )
    // The very first frame matters most: the shield must be up before capture starts.
    const firstFrameDiff = hudDifference(screenPath, recordingPage, recordingBounds, displayBounds, 0)
    check('the HUD is not in the first frame either', firstFrameDiff > HUD_ABSENT_ABOVE, `difference ${firstFrameDiff.toFixed(1)}`)

    // Desirable, not guaranteed: recent macOS versions no longer honour
    // content protection for every kind of capture.
    const screenshotDiff = hudDifference(recordingScreen, recordingPage, recordingBounds, displayBounds)
    note(
      screenshotDiff > HUD_ABSENT_ABOVE
        ? 'HUD is also hidden from system screenshots while recording'
        : 'HUD is still visible in system screenshots while recording',
      `difference ${screenshotDiff.toFixed(1)}`
    )

    // --- telemetry ------------------------------------------------------------
    const cursor = JSON.parse(readFileSync(join(sessionDir, 'cursor.json'), 'utf8'))
    const interactions = JSON.parse(readFileSync(join(sessionDir, 'interactions.json'), 'utf8'))
    const cursorTimes = cursor.map((sample) => sample.timeMs)
    const sampleRate = (cursor.length / video.durationMs) * 1000
    check(
      'cursor telemetry is sampled at ~30 Hz on the recording clock',
      sampleRate > 24 &&
        sampleRate < 36 &&
        cursorTimes.every((time, index) => time >= 0 && time <= video.durationMs && (index === 0 || time > cursorTimes[index - 1])),
      `${cursor.length} samples, ${sampleRate.toFixed(1)} Hz, last at ${Math.round(cursorTimes.at(-1))} ms`
    )
    const largestGap = Math.max(...cursorTimes.slice(1).map((time, index) => time - cursorTimes[index]))
    check('the pause leaves no hole in the telemetry timeline', largestGap < 200, `largest gap ${Math.round(largestGap)} ms`)
    check(
      'clicks on the HUD itself are not recorded as interactions',
      Array.isArray(interactions) && manifest.assets.interactions?.entryCount === interactions.length,
      `${interactions.length} interactions`
    )

    // --- editor: a zoom is a description, applied live in the preview -----------
    if (editorOpened) {
      const canvas = mainPage.locator('.preview-canvas')
      const lane = await mainPage.locator('.lane-video').boundingBox()
      const seekTo = async (timeMs) => {
        await mainPage.mouse.click(lane.x + (lane.width * timeMs) / video.durationMs, lane.y + lane.height / 2)
        await sleep(600)
      }
      const shot = async (name) => {
        const file = join(workDir, name)
        await canvas.screenshot({ path: file })
        return run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
      }
      const readZooms = () =>
        JSON.parse(readFileSync(join(sessionDir, 'project.json'), 'utf8')).effects.filter((effect) => effect.type === 'zoom')

      // Real clicks made on this machine during the run produce automatic
      // zooms; the manual zoom tested here is told apart from those.
      const automatic = readZooms().length
      if (automatic > 0) note('automatic zooms were generated from real clicks during the run', `${automatic}`)

      await seekTo(0)
      await mainPage.getByRole('tab', { name: 'Zoom' }).click()
      await mainPage.click('text=Adicionar zoom aqui')
      const manualBlock = mainPage.locator('.zoom-block[data-mode="manual"]')
      const added = await manualBlock.waitFor({ timeout: 3000 }).then(() => true, () => false)
      if (!added) {
        note('no room for a manual zoom at the start of this recording', 'manual zoom checks skipped')
      } else {
        await sleep(700)
        const saved = readZooms()
        const manual = saved.find((zoom) => zoom.mode === 'manual')
        check(
          'a manual zoom is saved to project.json as a description',
          saved.length === automatic + 1 && Boolean(manual) && manual.scale > 1 && manual.endMs > manual.startMs,
          JSON.stringify(manual && { startMs: manual.startMs, endMs: manual.endMs, scale: manual.scale, focus: manual.focus })
        )

        const middle = (manual.startMs + manual.endMs) / 2
        await seekTo(middle)
        const zoomed = await shot('preview-zoomed.png')
        if (keepArtifacts) await mainPage.screenshot({ path: join(workDir, 'editor.png') })

        await manualBlock.click()
        await mainPage.keyboard.press('Delete')
        await manualBlock.waitFor({ state: 'detached' })
        await seekTo(middle)
        const plain = await shot('preview-plain.png')
        await sleep(700)
        const zoomDifference = meanAbsoluteDifference(zoomed, plain)
        check('the preview shows the zoom while it exists', zoomDifference > 2, `difference ${zoomDifference.toFixed(1)} with vs without the zoom`)
        check('removing the zoom is saved too', readZooms().length === automatic)

        // Undo brings the zoom back; redo removes it again.
        await mainPage.click('[aria-label="Desfazer"]')
        const restored = await manualBlock.waitFor({ timeout: 3000 }).then(() => true, () => false)
        await mainPage.click('[aria-label="Refazer"]')
        const removedAgain = await manualBlock.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)
        await sleep(700)
        check('undo and redo work and are saved', restored && removedAgain && readZooms().length === automatic)
      }
      // --- export: what the preview shows, at any speed, with cuts ----------------
      const probeAll = (file) =>
        JSON.parse(
          run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,duration', '-of', 'json', file]).toString()
        ).streams
      const exportNow = async (speedLabel) => {
        const before = new Set(readdirSync(exportsDir))
        await mainPage.getByRole('button', { name: 'Exportar', exact: true }).click()
        await mainPage.getByRole('radio', { name: speedLabel, exact: true }).click()
        if (keepArtifacts) await mainPage.screenshot({ path: join(workDir, `export-dialog-${speedLabel}.png`) })
        const startedAt = Date.now()
        await mainPage.getByRole('button', { name: 'Exportar MP4' }).click()
        const outcome = await Promise.race([
          mainPage.getByRole('button', { name: 'Concluir' }).waitFor({ timeout: 180_000 }).then(() => 'done'),
          mainPage.locator('.dialog-error').waitFor({ timeout: 180_000 }).then(() => 'failed')
        ])
        const seconds = (Date.now() - startedAt) / 1000
        if (outcome !== 'done') {
          const message = await mainPage.locator('.dialog-error').innerText()
          await mainPage.getByRole('button', { name: 'Fechar' }).click()
          return { error: message }
        }
        await mainPage.getByRole('button', { name: 'Concluir' }).click()
        const created = readdirSync(exportsDir).filter((name) => !before.has(name))
        const file = join(exportsDir, created[0])
        const streams = probeAll(file)
        return {
          file,
          seconds,
          video: streams.find((stream) => stream.codec_type === 'video'),
          audio: streams.find((stream) => stream.codec_type === 'audio'),
          leftovers: readdirSync(exportsDir).filter((name) => name.endsWith('.part'))
        }
      }

      // 1x, no cuts: the file must match the recording and the preview.
      const normal = await exportNow('1×')
      const normalMs = Number(normal.video?.duration) * 1000
      check(
        'export produces an H.264 yuv420p MP4 as long as the edit',
        !normal.error && normal.video.codec_name === 'h264' && normal.video.pix_fmt === 'yuv420p' && Math.abs(normalMs - video.durationMs) < 150,
        normal.error ?? `${normal.video.width}x${normal.video.height}, ${Math.round(normalMs)} ms, rendered in ${normal.seconds.toFixed(1)} s`
      )
      if (!normal.error) {
        check(
          'the exported file carries the mixed audio, in sync',
          Boolean(normal.audio) && normal.audio.codec_name === 'aac' && Math.abs(Number(normal.audio.duration) * 1000 - normalMs) < 200,
          normal.audio ? `aac, ${Math.round(Number(normal.audio.duration) * 1000)} ms` : 'no audio stream'
        )
        check('no partial file is left behind', normal.leftovers.length === 0)

        // The same instant in the preview and in the exported file must look the same.
        const parityMs = 2000
        await seekTo(parityMs)
        const previewFile = join(workDir, 'parity-preview.png')
        await canvas.screenshot({ path: previewFile })
        // Compared at a small size: the two are rendered at different resolutions,
        // so fine text aliases differently; composition and content must agree.
        const previewSize = probe(previewFile)
        const small = { width: 480, height: Math.round((480 * previewSize.height) / previewSize.width / 2) * 2 }
        const scaled = (file, time) =>
          run('ffmpeg', [
            '-v', 'error', ...(time === null ? [] : ['-ss', String(time)]), '-i', file, '-frames:v', '1',
            '-vf', `scale=${small.width}:${small.height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
          ])
        const parity = meanAbsoluteDifference(scaled(previewFile, null), scaled(normal.file, parityMs / 1000))
        check('the exported frame matches the preview of the same instant', parity < 6, `difference ${parity.toFixed(1)}`)
      }

      // The timeline shows the recording itself: thumbnails and waveforms.
      const waveform = await mainPage.evaluate(
        (id) => window.screenrx.editor.waveform(id, 'systemAudio'),
        finished.lastCompletedSessionId
      )
      check(
        'the audio waveform is computed for the timeline',
        waveform.ok && waveform.value.length > 100 && waveform.value.every((peak) => peak >= 0 && peak <= 1),
        waveform.ok ? `${waveform.value.length} points` : waveform.error.detail
      )

      // Select a stretch by dragging over the video, then cut it. With 2x on
      // top, the result is (recording − cut) / 2.
      const selectFromMs = 1500
      const selectToMs = 3500
      const laneY = lane.y + lane.height / 2
      const laneX = (timeMs) => lane.x + (lane.width * timeMs) / video.durationMs
      await mainPage.mouse.move(laneX(selectFromMs), laneY)
      await mainPage.mouse.down()
      await mainPage.mouse.move(laneX((selectFromMs + selectToMs) / 2), laneY, { steps: 4 })
      await mainPage.mouse.move(laneX(selectToMs), laneY, { steps: 4 })
      await mainPage.mouse.up()
      const selected = await mainPage.locator('.selection-band').waitFor({ timeout: 3000 }).then(() => true, () => false)
      check('dragging over the video selects a stretch', selected, selected ? (await mainPage.locator('.selection-bar').innerText()).replace(/\s+/g, ' ') : '')
      if (keepArtifacts) await mainPage.screenshot({ path: join(workDir, 'editor-selection.png') })

      await mainPage.getByRole('button', { name: 'Cortar seleção' }).first().click()
      await mainPage.locator('.trim-block').waitFor()
      await sleep(700)
      const cut = JSON.parse(readFileSync(join(sessionDir, 'project.json'), 'utf8')).effects.find((effect) => effect.type === 'trim')
      const keptMs = video.durationMs - (cut ? cut.endMs - cut.startMs : 0)
      check(
        'cutting the selection is saved to project.json as a description',
        Boolean(cut) && Math.abs(cut.startMs - selectFromMs) < 80 && Math.abs(cut.endMs - selectToMs) < 80,
        JSON.stringify(cut && { startMs: Math.round(cut.startMs), endMs: Math.round(cut.endMs) })
      )
      check('the selection is consumed by the cut', (await mainPage.locator('.selection-band').count()) === 0)
      const durationLabel = await mainPage.locator('.transport-duration').innerText()
      check('the editor clock shows the edited duration', durationLabel.includes(`0${Math.floor(keptMs / 1000)}`.slice(-2)), durationLabel.trim())

      const fast = await exportNow('2×')
      const fastMs = Number(fast.video?.duration) * 1000
      check(
        'exporting at 2x with a cut yields (recording − cut) / 2',
        !fast.error && Math.abs(fastMs - keptMs / 2) < 150,
        fast.error ?? `${Math.round(keptMs)} ms kept → ${Math.round(fastMs)} ms at 2x, rendered in ${fast.seconds.toFixed(1)} s`
      )
      if (!fast.error) {
        check(
          'audio is sped up with the video',
          Boolean(fast.audio) && Math.abs(Number(fast.audio.duration) * 1000 - fastMs) < 200,
          fast.audio ? `${Math.round(Number(fast.audio.duration) * 1000)} ms` : 'no audio stream'
        )
      }

      // Cancelling mid-export stops the encoder and leaves nothing on disk.
      const beforeCancel = readdirSync(exportsDir).length
      await mainPage.getByRole('button', { name: 'Exportar', exact: true }).click()
      await mainPage.getByRole('radio', { name: '0,5×', exact: true }).click()
      await mainPage.getByRole('button', { name: 'Exportar MP4' }).click()
      await mainPage.getByRole('button', { name: 'Cancelar exportação' }).click()
      const backToSettings = await mainPage
        .getByRole('button', { name: 'Exportar MP4' })
        .waitFor({ timeout: 15_000 })
        .then(() => true, () => false)
      await sleep(500)
      check(
        'cancelling an export leaves no file behind',
        backToSettings && readdirSync(exportsDir).length === beforeCancel,
        readdirSync(exportsDir).join(', ')
      )
      await mainPage.getByRole('button', { name: 'Cancelar', exact: true }).click()

      check(
        'editing never modifies the recorded video',
        probe(screenPath).nb_frames === video.nb_frames && readFileSync(join(sessionDir, 'session.json'), 'utf8') === JSON.stringify(manifest, null, 2) + '\n'
      )
    }

    // --- companion tracks: separate files, in sync with the screen ---------------
    const expectedTracks = [
      ['systemAudio', 'system.m4a', true],
      ['microphone', 'microphone.m4a', Boolean(microphone)],
      ['webcam', 'webcam.mp4', Boolean(camera)]
    ]
    for (const [key, file, expected] of expectedTracks) {
      const filePath = join(sessionDir, file)
      if (!expected) {
        check(`${file} is not created when its track is off`, !existsSync(filePath))
        continue
      }
      const asset = manifest.assets[key]
      const trackMs = existsSync(filePath) ? Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]).toString()) * 1000 : NaN
      check(
        `${file} is recorded separately and lasts as long as the screen track`,
        Boolean(asset) && Math.abs(trackMs - video.durationMs) < 250,
        `${Math.round(trackMs)} ms vs ${Math.round(video.durationMs)} ms of screen`
      )
    }

    const files = readdirSync(sessionDir).sort()
    const expectedFiles = [
      'cursor.json', 'interactions.json', 'project.json', 'screen.mp4', 'session.json',
      ...expectedTracks.filter(([, , expected]) => expected).map(([, file]) => file)
    ].sort().join(',')
    check('session holds exactly its tracks, telemetry, manifest and project', files.join(',') === expectedFiles, files.join(','))

    // --- home: the recording shows up in the library with its poster -----------
    if (editorOpened) {
      await mainPage.getByRole('button', { name: 'Gravações' }).click()
      const poster = mainPage.locator('.card-poster img')
      const posterLoaded = await poster
        .waitFor({ timeout: 15_000 })
        .then(() => mainPage.waitForFunction(() => document.querySelector('.card-poster img')?.naturalWidth > 0, null, { timeout: 15_000 }))
        .then(() => true, () => false)
      const cardText = posterLoaded ? (await mainPage.locator('.card').first().innerText()).replace(/\s+/g, ' ') : ''
      check('the library shows the recording as a card with its poster frame', posterLoaded, cardText)
      if (keepArtifacts) await mainPage.screenshot({ path: join(workDir, 'home.png') })
    }

    const library = await hud.evaluate(() => window.screenrx.library.list())
    check('the recording is listed in the library', library.length === 1 && library[0].status === 'completed')

    const afterWindows = await windowStates()
    check(
      'after recording the library is back, the bar is gone, and nothing is still protected',
      afterWindows.find((window) => window.page === 'index.html')?.visible === true &&
        afterWindows.find((window) => window.page === 'hud.html')?.visible === false &&
        afterWindows.every((window) => !window.protected),
      JSON.stringify(afterWindows.map(({ page, visible, protected: shielded }) => ({ page, visible, shielded })))
    )

    if (keepArtifacts) {
      const half = String(RECORD_BEFORE_PAUSE_MS / 2000)
      run('ffmpeg', ['-v', 'error', '-y', '-ss', half, '-i', screenPath, '-frames:v', '1', join(workDir, 'recorded-frame.png')])
    }
  } finally {
    await app.close()
  }
}

if (isScreenLocked()) {
  console.log('The screen is locked: unlock it and run again (the HUD checks need a visible desktop).')
  rmSync(workDir, { recursive: true, force: true })
  process.exit(2)
}

try {
  await main()
} catch (error) {
  check('end-to-end run completed', false, String(error))
} finally {
  if (keepArtifacts) console.log(`artifacts kept in ${workDir}`)
  else rmSync(workDir, { recursive: true, force: true })
}

const failed = checks.filter((entry) => !entry.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
