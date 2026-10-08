import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/models/update'
import type { Logger } from '../logging/logger'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  MIN_GAP_MS,
  UpdateService,
  describeUpdateError
} from './UpdateService'
import type { UpdaterDriver } from './UpdateService'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

class FakeDriver extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installs = 0
  checkForUpdates = vi.fn(async () => {
    this.checks += 1
  })
  quitAndInstall = vi.fn(() => {
    this.installs += 1
  })
}

let driver: FakeDriver
let states: UpdateState[]
let busy: boolean
let clock: number

function service(packaged = true): UpdateService {
  return new UpdateService({
    driver: driver as unknown as UpdaterDriver,
    packaged,
    currentVersion: '0.1.0',
    logger,
    onChange: (state) => states.push(state),
    busy: () => busy,
    now: () => clock
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  driver = new FakeDriver()
  states = []
  busy = false
  clock = 1_000_000
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateService', () => {
  it('does nothing in a build that is not installed', async () => {
    const updates = service(false)
    updates.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + CHECK_INTERVAL_MS)

    expect(driver.checks).toBe(0)
    expect(updates.getState()).toEqual({ status: 'unsupported', current: '0.1.0' })
    expect(await updates.check()).toEqual({ status: 'unsupported', current: '0.1.0' })
  })

  it('checks after launch and every half hour, downloading and installing on quit', async () => {
    const updates = service()
    updates.start()
    expect(driver.autoDownload).toBe(true)
    expect(driver.autoInstallOnAppQuit).toBe(true)

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    expect(driver.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(driver.checks).toBe(2)
    updates.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(driver.checks).toBe(2)
  })

  it('follows a version from found to downloaded', () => {
    const updates = service()
    updates.start()

    driver.emit('checking-for-update')
    driver.emit('update-available', { version: '0.2.0' })
    driver.emit('download-progress', { percent: 41.6 })
    driver.emit('update-downloaded', { version: '0.2.0' })

    expect(states.map((state) => state.status)).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(states[2]).toMatchObject({ version: '0.2.0', percent: 42 })
    expect(updates.getState()).toMatchObject({ status: 'ready', version: '0.2.0', percent: 100 })
  })

  it('goes back to idle, remembering when it looked, when there is nothing newer', () => {
    const updates = service()
    updates.start()
    driver.emit('checking-for-update')
    driver.emit('update-not-available')

    expect(updates.getState()).toMatchObject({ status: 'idle', checkedAt: clock })
  })

  it('leaves a download in progress and a ready version alone', async () => {
    const updates = service()
    updates.start()
    driver.emit('update-available', { version: '0.2.0' })
    await updates.check()
    expect(driver.checks).toBe(0)

    driver.emit('update-downloaded', { version: '0.2.0' })
    await updates.check()
    expect(driver.checks).toBe(0)
  })

  it('looks again on coming back only when the last look is old enough', async () => {
    const updates = service()
    updates.start()
    await updates.check()
    expect(driver.checks).toBe(1)
    driver.emit('update-not-available')

    clock += MIN_GAP_MS - 1
    updates.checkIfStale()
    expect(driver.checks).toBe(1)

    clock += 1
    updates.checkIfStale()
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.checks).toBe(2)
  })

  it('reports a failure in words, and tries again later', async () => {
    const updates = service()
    updates.start()
    driver.emit('error', new Error('getaddrinfo ENOTFOUND github.com\nheaders…'))

    expect(updates.getState()).toMatchObject({ status: 'error', error: 'Sem conexão com o servidor de atualizações.' })
    await updates.check()
    expect(driver.checks).toBe(1)
  })

  it('reports a check that throws before any event', async () => {
    driver.checkForUpdates.mockRejectedValueOnce(new Error('boom\nstack'))
    const updates = service()
    updates.start()
    await updates.check()

    expect(updates.getState()).toMatchObject({ status: 'error', error: 'boom' })
  })

  it('installs only a downloaded version, and never while something is running', () => {
    const updates = service()
    updates.start()
    expect(updates.install()).toBe(false)

    driver.emit('update-downloaded', { version: '0.2.0' })
    busy = true
    expect(updates.install()).toBe(false)
    expect(driver.installs).toBe(0)

    busy = false
    expect(updates.install()).toBe(true)
    expect(driver.installs).toBe(1)
  })
})

describe('describeUpdateError', () => {
  it('shortens what the updater reports', () => {
    expect(describeUpdateError(new Error('Cannot find latest-mac.yml in the latest release artifacts'))).toBe(
      'Nenhuma versão publicada foi encontrada.'
    )
    expect(describeUpdateError(new Error('x'.repeat(500))).length).toBe(200)
  })
})
