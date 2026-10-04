import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../logging/logger'
import type { HelperChild } from './HelperProcess'
import { HelperProcess } from './HelperProcess'
import { MacCaptureEngine } from './MacCaptureEngine'

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * A helper that answers like the real one. As on macOS, the permission
 * grant is fixed when the process starts: it reflects `world.granted` at
 * spawn time, however that changes later.
 */
class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  constructor(world: World) {
    super()
    const grantedAtSpawn = world.granted
    let buffer = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const request = JSON.parse(line) as { id: string; method: string }
        const result =
          request.method === 'hello'
            ? { protocolVersion: world.protocolVersion, osVersion: 'test' }
            : {
                screenRecording: grantedAtSpawn,
                microphone: 'granted',
                camera: 'undetermined',
                responsibleExecutable: world.responsible
              }
        // Answer asynchronously, like a real process would.
        setImmediate(() =>
          this.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, ok: true, result })}\n`)
        )
      }
    })
    this.stdin.on('end', () => setImmediate(() => this.emit('exit', 0, null)))
  }

  kill(): boolean {
    this.emit('exit', null, 'SIGKILL')
    return true
  }
}

interface World {
  granted: boolean
  protocolVersion: number
  responsible: string
  spawned: number
}

let world: World
let engine: MacCaptureEngine

beforeEach(() => {
  world = {
    granted: false,
    protocolVersion: 2,
    responsible: '/Applications/Claude.app/Contents/MacOS/Claude',
    spawned: 0
  }
  const helper = new HelperProcess(() => {
    world.spawned += 1
    return new FakeHelper(world) as unknown as HelperChild
  }, silentLogger)
  engine = new MacCaptureEngine(helper, silentLogger)
})

describe('MacCaptureEngine permissions', () => {
  it('reports the grant and who macOS attributes it to', async () => {
    expect(await engine.getPermissions()).toEqual({
      permissions: { screenRecording: 'not-granted', microphone: 'granted', camera: 'not-granted' },
      grantee: { name: 'Claude', isLauncher: true }
    })
  })

  it('respawns the helper to notice a permission granted after launch', async () => {
    await engine.getPermissions()
    world.granted = true
    const report = await engine.getPermissions()
    expect(report.permissions.screenRecording).toBe('granted')
    expect(world.spawned).toBe(2)

    // Once granted there is nothing left to refresh.
    await engine.getPermissions()
    expect(world.spawned).toBe(2)
  })

  it('serves concurrent checks from one helper instead of killing each other', async () => {
    await engine.getPermissions()
    const reports = await Promise.all([
      engine.getPermissions(),
      engine.getPermissions(),
      engine.getPermissions(),
      engine.getPermissions()
    ])
    expect(reports.map((report) => report.permissions.screenRecording)).toEqual([
      'not-granted',
      'not-granted',
      'not-granted',
      'not-granted'
    ])
    expect(world.spawned).toBe(2)
  })

  it('does not respawn the helper under a request that is still in flight', async () => {
    await engine.getPermissions()
    const requesting = engine.requestScreenRecordingPermission()
    const checking = engine.getPermissions()
    await expect(requesting).resolves.toMatchObject({ permissions: { screenRecording: 'not-granted' } })
    await expect(checking).resolves.toMatchObject({ permissions: { screenRecording: 'not-granted' } })
    expect(world.spawned).toBe(1)
  })

  it('rejects a helper that speaks another protocol version', async () => {
    world.protocolVersion = 99
    await expect(engine.getPermissions()).rejects.toMatchObject({
      appError: { code: 'capture-helper-unavailable' }
    })
  })
})
