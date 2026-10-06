import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaptureSourceCatalog, DisplaySource } from '@shared/models/capture'
import type { CaptureDevices } from '@shared/models/devices'
import { appError } from '@shared/models/errors'
import type { PermissionReport, PermissionState } from '@shared/models/permissions'
import type { RecordingSessionManifest } from '@shared/models/session'
import type {
  CaptureEngine,
  CaptureInterruption,
  CaptureResult,
  StartCaptureRequest
} from '../capture/CaptureEngine'
import { CaptureError } from '../capture/CaptureEngine'
import type { Logger } from '../logging/logger'
import { RecordingController } from './RecordingController'
import { SessionStore } from './SessionStore'

const OWN_PID = 4242
const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const display: DisplaySource = {
  kind: 'display',
  id: 'display:1',
  displayId: 1,
  index: 1,
  name: 'Built-in Display',
  isMain: true,
  widthPx: 3024,
  heightPx: 1964,
  scaleFactor: 2,
  thumbnailDataUrl: null
}

/** Scriptable capture engine that writes a small file where the screen track goes. */
class FakeEngine implements CaptureEngine {
  screenRecording: PermissionState = 'granted'
  microphoneAccess: PermissionState = 'granted'
  devices: CaptureDevices = {
    microphones: [{ id: 'mic-1', name: 'MacBook Microphone', isDefault: true }],
    cameras: [{ id: 'cam-1', name: 'FaceTime Camera', isDefault: true }]
  }
  catalog: CaptureSourceCatalog = { displays: [display], windows: [] }
  startError: CaptureError | null = null
  excludedPids: number[] = [OWN_PID]
  resultOverrides: Partial<CaptureResult> = {}
  fileBytes = 1024
  recordingTimeMs = 0
  startRequests: StartCaptureRequest[] = []
  calls: string[] = []
  private listener: ((interruption: CaptureInterruption) => void) | null = null

  getPermissions = async (): Promise<PermissionReport> => ({
    permissions: {
      screenRecording: this.screenRecording,
      microphone: this.microphoneAccess,
      camera: 'granted'
    },
    grantee: { name: 'Terminal', isLauncher: true }
  })
  requestScreenRecordingPermission = this.getPermissions
  requestMediaPermission = this.getPermissions
  listDevices = async () => this.devices
  listSources = async () => this.catalog

  async start(request: StartCaptureRequest) {
    this.calls.push('start')
    if (this.startError) throw this.startError
    this.startRequests.push(request)
    return { widthPx: 3024, heightPx: 1964, fps: request.fps, excludedPids: this.excludedPids }
  }

  async pause() {
    this.calls.push('pause')
    return { recordingTimeMs: this.recordingTimeMs }
  }

  async resume() {
    this.calls.push('resume')
    return { recordingTimeMs: this.recordingTimeMs }
  }

  async stop() {
    this.calls.push('stop')
    return this.finishFile()
  }

  onInterrupted(listener: (interruption: CaptureInterruption) => void) {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  dispose = async () => undefined

  async finishFile(): Promise<CaptureResult> {
    const request = this.startRequests.at(-1)
    const outputPath = request?.outputPath ?? ''
    if (this.fileBytes > 0) await writeFile(outputPath, Buffer.alloc(this.fileBytes))
    return {
      outputPath,
      durationMs: 5000,
      mediaDurationMs: 4990,
      fileSizeBytes: this.fileBytes,
      widthPx: 3024,
      heightPx: 1964,
      framesWritten: 300,
      framesDropped: 0,
      pauses: [],
      telemetry: { cursorSamples: 150, interactions: 4 },
      microphone: null,
      // Like the real engine: the computer's sound comes back as a track when it was asked for.
      systemAudio: request?.systemAudio
        ? { durationMs: 4990, fileSizeBytes: 1024, widthPx: null, heightPx: null }
        : null,
      webcam: null,
      ...this.resultOverrides
    }
  }

  interrupt(interruption: CaptureInterruption): void {
    this.listener?.(interruption)
  }
}

class FakeShield {
  engaged = false
  history: string[] = []
  engage(): void {
    this.engaged = true
    this.history.push('engage')
  }
  release(): void {
    this.engaged = false
    this.history.push('release')
  }
}

let root: string
let engine: FakeEngine
let shield: FakeShield
let sessions: SessionStore
let controller: RecordingController
let now: number

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'screenrx-controller-'))
  engine = new FakeEngine()
  shield = new FakeShield()
  sessions = new SessionStore(root, silentLogger)
  now = 0
  controller = new RecordingController({
    engine,
    sessions,
    shield,
    logger: silentLogger,
    monotonicNow: () => now,
    wallClock: () => new Date(2026, 9, 3, 20, 15, 30, 123),
    ownPids: () => [OWN_PID]
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readManifest(sessionId: string): Promise<RecordingSessionManifest> {
  const raw = await readFile(path.join(root, sessionId, 'session.json'), 'utf8')
  return JSON.parse(raw) as RecordingSessionManifest
}

/** Lets the controller's queue process an interruption raised by the engine. */
const settle = (): Promise<void> => controller.pause()

describe('RecordingController', () => {
  it('starts recording the main display by default, shielding the app first', async () => {
    await controller.start()

    const state = controller.getState()
    expect(state.phase).toBe('recording')
    expect(state.selectedSource).toEqual({ id: 'display:1', kind: 'display', label: 'Built-in Display' })
    expect(state.sessionId).toBe('recording-20261003-201530-123')
    expect(state.clockRunning).toBe(true)
    expect(shield.engaged).toBe(true)

    const request = engine.startRequests[0]
    expect(request?.excludePids).toEqual([OWN_PID])
    expect(request?.outputPath).toBe(path.join(root, 'recording-20261003-201530-123', 'screen.mp4'))
    expect((await readManifest('recording-20261003-201530-123')).status).toBe('recording')
  })

  it('names the session after a source chosen with a title, and only for that recording', async () => {
    await controller.useSource(display, 'Reunião · Daily')
    await controller.start()
    const first = controller.getState().sessionId as string
    expect((await readManifest(first)).title).toBe('Reunião · Daily')

    now += 1000
    await controller.stop()
    await controller.start()
    const second = controller.getState().sessionId as string
    expect((await readManifest(second)).title).toBeUndefined()
  })

  it('adds audio gathered elsewhere as the system-audio track before announcing the recording', async () => {
    const requests: unknown[] = []
    const withExternal = new RecordingController({
      engine,
      sessions,
      shield,
      logger: silentLogger,
      monotonicNow: () => now,
      wallClock: () => new Date(2026, 9, 3, 20, 15, 30, 123),
      ownPids: () => [OWN_PID],
      externalSystemAudio: async (request) => {
        requests.push(request)
        await writeFile(request.outputPath, 'audio')
        return { sizeBytes: 5, durationMs: 1234 }
      }
    })
    await withExternal.setSystemAudio(false)
    await withExternal.start()
    const id = withExternal.getState().sessionId as string
    now += 2000
    await withExternal.stop()

    const manifest = await readManifest(id)
    expect(manifest.assets.systemAudio).toEqual({ file: 'system.m4a', sizeBytes: 5, durationMs: 1234 })
    expect(requests).toEqual([
      {
        outputPath: path.join(root, id, 'system.m4a'),
        startedAtWallMs: new Date(2026, 9, 3, 20, 15, 30, 123).getTime(),
        durationMs: expect.any(Number),
        pauses: []
      }
    ])
    expect(withExternal.getState().lastCompletedSessionId).toBe(id)
  })

  it('keeps the recording when the external audio fails, with a warning', async () => {
    const withExternal = new RecordingController({
      engine,
      sessions,
      shield,
      logger: silentLogger,
      monotonicNow: () => now,
      wallClock: () => new Date(2026, 9, 3, 20, 15, 30, 123),
      ownPids: () => [OWN_PID],
      externalSystemAudio: async () => {
        throw new Error('ffmpeg exploded')
      }
    })
    await withExternal.setSystemAudio(false)
    await withExternal.start()
    const id = withExternal.getState().sessionId as string
    now += 2000
    await withExternal.stop()

    const manifest = await readManifest(id)
    expect(manifest.status).toBe('completed')
    expect(manifest.assets.systemAudio).toBeUndefined()
    expect(manifest.diagnostics.some((d) => d.code === 'track-missing')).toBe(true)
  })

  it('refuses to start without the screen recording permission and leaves nothing behind', async () => {
    engine.screenRecording = 'not-granted'
    await controller.start()

    const state = controller.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastError?.code).toBe('screen-recording-permission-denied')
    expect(engine.calls).toEqual([])
    expect(shield.engaged).toBe(false)
    expect(await readdir(root)).toEqual([])
  })

  it('discards the session and releases the shield when the engine fails to start', async () => {
    engine.startError = new CaptureError(appError('source-unavailable'))
    await controller.start()

    const state = controller.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastError?.code).toBe('source-unavailable')
    expect(state.selectedSource).toBeNull()
    expect(shield.history).toEqual(['engage', 'release'])
    expect(await readdir(root)).toEqual([])
  })

  it('pauses and resumes following the engine clock', async () => {
    await controller.start()
    now = 3000
    engine.recordingTimeMs = 2950
    await controller.pause()

    let state = controller.getState()
    expect(state.phase).toBe('paused')
    expect(state.clockRunning).toBe(false)
    expect(state.elapsedMs).toBe(2950)

    now = 13000
    await controller.resume()
    now = 14000
    state = controller.getState()
    expect(state.phase).toBe('recording')
    expect(state.elapsedMs).toBe(3950)
  })

  it('finalizes the session manifest on stop', async () => {
    await controller.start()
    engine.resultOverrides = { pauses: [{ atMs: 1000, pausedForMs: 2000 }] }
    await controller.stop()

    const state = controller.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastError).toBeNull()
    expect(state.lastCompletedSessionId).toBe('recording-20261003-201530-123')
    expect(shield.engaged).toBe(false)

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.status).toBe('completed')
    expect(manifest.clock).toEqual({ durationMs: 5000, pauses: [{ atMs: 1000, pausedForMs: 2000 }] })
    expect(manifest.assets.screen).toMatchObject({
      file: 'screen.mp4',
      sizeBytes: 1024,
      durationMs: 4990,
      frameCount: 300
    })
    expect(manifest.assets.cursor).toEqual({ file: 'cursor.json', entryCount: 150 })
    expect(manifest.assets.interactions).toEqual({ file: 'interactions.json', entryCount: 4 })
    expect(manifest.diagnostics).toEqual([])
    expect(await sessions.list()).toHaveLength(1)

    const request = engine.startRequests[0]
    expect(request?.telemetry).toEqual({
      cursorPath: path.join(root, 'recording-20261003-201530-123', 'cursor.json'),
      interactionsPath: path.join(root, 'recording-20261003-201530-123', 'interactions.json'),
      sampleRateHz: 30
    })
  })

  it('reports duration drift instead of hiding it', async () => {
    await controller.start()
    engine.resultOverrides = { durationMs: 5000, mediaDurationMs: 4200 }
    await controller.stop()

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.status).toBe('completed')
    expect(manifest.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duration-drift'])
    expect((await sessions.list())[0]?.hasWarnings).toBe(true)
  })

  it("records the screen and the computer's sound by default, without microphone or camera", async () => {
    expect(controller.getState().options).toMatchObject({ microphoneId: null, systemAudio: true, cameraId: null })
    await controller.start()
    expect(engine.startRequests[0]).toMatchObject({
      microphone: null,
      systemAudio: { outputPath: path.join(root, 'recording-20261003-201530-123', 'system.m4a') },
      webcam: null
    })
    await controller.stop()
    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.assets.systemAudio).toMatchObject({ file: 'system.m4a' })
    expect(manifest.diagnostics).toEqual([])
  })

  it("records only the screen when the computer's sound is turned off", async () => {
    await controller.setSystemAudio(false)
    await controller.start()
    expect(engine.startRequests[0]).toMatchObject({ microphone: null, systemAudio: null, webcam: null })
    await controller.stop()
    expect((await readManifest('recording-20261003-201530-123')).assets.systemAudio).toBeUndefined()
  })

  it('records the enabled microphone, system audio and camera to their own files', async () => {
    await controller.setMicrophone('mic-1')
    await controller.setSystemAudio(true)
    await controller.setCamera('cam-1')
    expect(controller.getState().options).toEqual({
      microphoneId: 'mic-1',
      microphoneName: 'MacBook Microphone',
      systemAudio: true,
      cameraId: 'cam-1',
      cameraName: 'FaceTime Camera'
    })

    await controller.start()
    const directory = path.join(root, 'recording-20261003-201530-123')
    expect(engine.startRequests[0]).toMatchObject({
      microphone: { deviceId: 'mic-1', outputPath: path.join(directory, 'microphone.m4a') },
      systemAudio: { outputPath: path.join(directory, 'system.m4a') },
      webcam: { deviceId: 'cam-1', outputPath: path.join(directory, 'webcam.mp4'), fps: 30 }
    })

    const track = { durationMs: 4980, fileSizeBytes: 2048, widthPx: null, heightPx: null }
    engine.resultOverrides = {
      microphone: track,
      systemAudio: track,
      webcam: { ...track, widthPx: 1280, heightPx: 720 }
    }
    await controller.stop()

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.assets.microphone).toEqual({
      file: 'microphone.m4a',
      sizeBytes: 2048,
      durationMs: 4980,
      deviceName: 'MacBook Microphone'
    })
    expect(manifest.assets.systemAudio).toMatchObject({ file: 'system.m4a', durationMs: 4980 })
    expect(manifest.assets.webcam).toMatchObject({ file: 'webcam.mp4', widthPx: 1280, heightPx: 720 })
    expect(manifest.diagnostics).toEqual([])
  })

  it('keeps a device off when its permission is refused', async () => {
    engine.microphoneAccess = 'not-granted'
    await controller.setMicrophone('mic-1')
    expect(controller.getState().options.microphoneId).toBeNull()
    expect(controller.getState().lastError?.code).toBe('microphone-permission-denied')
  })

  it('rejects a device that does not exist and can turn a device off again', async () => {
    await controller.setCamera('cam-404')
    expect(controller.getState().lastError?.code).toBe('device-unavailable')
    expect(controller.getState().options.cameraId).toBeNull()

    await controller.setCamera('cam-1')
    await controller.setCamera(null)
    expect(controller.getState().options.cameraId).toBeNull()
  })

  it('reports enabled tracks that were not recorded or drifted out of sync', async () => {
    await controller.setMicrophone('mic-1')
    await controller.setSystemAudio(true)
    await controller.start()
    engine.resultOverrides = {
      microphone: null,
      systemAudio: { durationMs: 4000, fileSizeBytes: 100, widthPx: null, heightPx: null }
    }
    await controller.stop()

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.status).toBe('completed')
    expect(manifest.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      'duration-drift',
      'track-missing'
    ])
    expect(manifest.diagnostics.find((diagnostic) => diagnostic.code === 'duration-drift')?.message).toContain(
      'System audio'
    )
  })

  it('flags a recording that ended without pointer telemetry', async () => {
    await controller.start()
    engine.resultOverrides = { telemetry: null }
    await controller.stop()

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.status).toBe('completed')
    expect(manifest.assets.interactions).toBeUndefined()
    expect(manifest.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['telemetry-missing'])
  })

  it('flags a display capture that could not exclude the app itself', async () => {
    engine.excludedPids = []
    await controller.start()
    await controller.stop()

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.diagnostics.map((diagnostic) => diagnostic.code)).toContain('self-exclusion-missing')
  })

  it('rejects an empty recording and removes its session', async () => {
    await controller.start()
    engine.fileBytes = 0
    engine.resultOverrides = { framesWritten: 0, mediaDurationMs: 0 }
    await controller.stop()

    const state = controller.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastError?.code).toBe('recording-invalid')
    expect(state.lastCompletedSessionId).toBeNull()
    expect(shield.engaged).toBe(false)
    expect(await readdir(root)).toEqual([])
  })

  it('keeps what was recorded when the capture is interrupted', async () => {
    await controller.start()
    engine.interrupt({ error: appError('source-unavailable'), result: await engine.finishFile() })
    await settle()

    const state = controller.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastError?.code).toBe('source-unavailable')
    expect(state.lastCompletedSessionId).toBe('recording-20261003-201530-123')
    expect(shield.engaged).toBe(false)

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.status).toBe('completed')
    expect(manifest.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['interrupted'])
  })

  it('fails the session when the capture helper dies', async () => {
    await controller.start()
    engine.interrupt({ error: appError('capture-helper-exited'), result: null })
    await settle()

    const state = controller.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastError?.code).toBe('capture-helper-exited')
    expect(shield.engaged).toBe(false)
    // Nothing usable was written, so no session is left in the library.
    expect(await sessions.list()).toEqual([])
  })

  it('keeps a partial file of a failed recording, marked as failed', async () => {
    await controller.start()
    await writeFile(engine.startRequests[0]?.outputPath ?? '', Buffer.alloc(2048))
    engine.interrupt({ error: appError('capture-helper-exited'), result: null })
    await settle()

    const manifest = await readManifest('recording-20261003-201530-123')
    expect(manifest.status).toBe('failed')
    expect(manifest.failure?.code).toBe('capture-helper-exited')
  })

  it('ignores actions that do not apply to the current phase', async () => {
    await controller.pause()
    await controller.resume()
    await controller.stop()
    expect(engine.calls).toEqual([])

    await Promise.all([controller.start(), controller.start()])
    expect(engine.calls).toEqual(['start'])

    await Promise.all([controller.pause(), controller.pause()])
    expect(engine.calls).toEqual(['start', 'pause'])
  })

  it('selects only sources that exist and never while recording', async () => {
    await controller.selectSource('window:99')
    expect(controller.getState().lastError?.code).toBe('source-unavailable')
    expect(controller.getState().selectedSource).toBeNull()

    await controller.selectSource('display:1')
    expect(controller.getState().selectedSource?.id).toBe('display:1')
    expect(controller.getState().lastError).toBeNull()

    await controller.selectSource('../../etc/passwd')
    expect(controller.getState().selectedSource?.id).toBe('display:1')
  })

  it('broadcasts every transition', async () => {
    const phases: string[] = []
    controller.onStateChanged((state) => phases.push(state.phase))
    await controller.start()
    await controller.pause()
    await controller.resume()
    await controller.stop()
    expect(phases).toEqual(['starting', 'recording', 'paused', 'recording', 'stopping', 'idle'])
  })
})
