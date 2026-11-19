import { describe, expect, it, vi } from 'vitest'
import type { EditorSession } from '@shared/models/editor'
import type { ExportJob } from '@shared/models/export'
import type { PublishState } from '@shared/models/instagram'
import type { RecordingSummary } from '@shared/models/session'
import { appError } from '@shared/models/errors'
import { ExportAbortedError } from '../export/renderExport'
import type { PublishQueueDeps } from './publishQueue'
import { PublishQueue, oldestApproved } from './publishQueue'

const recording = (id: string, createdAt: string, state: PublishState | null): RecordingSummary =>
  ({ id, createdAt, status: 'completed', title: id, publish: state ? { state, caption: '', permalink: null, error: null } : null }) as RecordingSummary

const job = { exportId: 'export-1', plan: { frameCount: 10 } } as unknown as ExportJob
const session = { project: { export: { preset: 'custom' }, background: { aspect: '16:9' } }, track: null } as unknown as EditorSession

function deps(overrides: Partial<PublishQueueDeps> = {}): PublishQueueDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    startExport: vi.fn(async (id: string) => {
      calls.push(`export ${id}`)
      return { ok: true as const, value: job }
    }),
    openSession: vi.fn(async () => ({ ok: true as const, value: session })),
    render: vi.fn(async (_job, _session, project, _track, onFrames) => {
      calls.push(`render ${project.background.aspect}`)
      onFrames(5)
    }),
    finishExport: vi.fn(async () => {
      calls.push('finish')
      return { ok: true as const, value: { exportId: 'export-1', fileName: 'x.mp4', sizeBytes: 1 } }
    }),
    cancelExport: vi.fn(async () => {
      calls.push('cancel')
    }),
    publish: vi.fn(async (id: string) => {
      calls.push(`publish ${id}`)
      return { ok: true as const, value: { state: 'published' as const, caption: '', approvedAt: '', username: 'x' } }
    }),
    mark: vi.fn(async (id: string, state: string) => {
      calls.push(`mark ${id} ${state}`)
      return { ok: true as const, value: null }
    }),
    withdraw: vi.fn(async (id: string) => {
      calls.push(`withdraw ${id}`)
      return { ok: true as const, value: null }
    }),
    onProgress: () => () => {},
    wait: async () => {},
    ...overrides
  }
}

const settle = (queue: PublishQueue): Promise<void> =>
  new Promise((resolve) => {
    const check = (): void => (queue.getState().current === null ? resolve() : void setTimeout(check, 1))
    setTimeout(check, 1)
  })

describe('PublishQueue', () => {
  it('picks the first approved episode of the library, oldest first', () => {
    const list = [recording('c', '2026-11-19T03', 'approved'), recording('a', '2026-11-19T01', 'published'), recording('b', '2026-11-19T02', 'approved'), recording('d', '2026-11-19T00', null)]
    expect(oldestApproved(list)?.id).toBe('b')
    expect(oldestApproved([recording('a', '1', 'failed')])).toBeNull()
  })

  it('draws the Reels file at 9:16 and publishes it; nothing without an account', async () => {
    const fake = deps()
    const queue = new PublishQueue(fake)
    queue.consider([recording('a', '1', 'approved')], false)
    expect(fake.calls).toEqual([])
    queue.consider([recording('a', '1', 'approved')], true)
    await settle(queue)
    expect(fake.calls).toEqual(['export a', 'render 9:16', 'finish', 'publish a'])
  })

  it('marks the recording failed when its file cannot be made, and gives a stopped one up', async () => {
    const failing = deps({
      render: vi.fn(async () => {
        throw new Error('decoder broke')
      })
    })
    const queue = new PublishQueue(failing)
    queue.consider([recording('a', '1', 'approved')], true)
    await settle(queue)
    expect(failing.calls).toEqual(['export a', 'cancel', 'mark a failed'])

    const stopped = deps({
      render: vi.fn(async () => {
        throw new ExportAbortedError()
      })
    })
    const second = new PublishQueue(stopped)
    second.consider([recording('a', '1', 'approved')], true)
    await settle(second)
    expect(stopped.calls).toEqual(['export a', 'cancel', 'withdraw a'])
  })

  it('waits while the editor is exporting, and skips a recording no longer waiting', async () => {
    let busy = true
    const fake = deps({
      startExport: vi.fn(async () => {
        if (busy) {
          busy = false
          return { ok: false as const, error: appError('export-busy') }
        }
        return { ok: false as const, error: appError('invalid-state', 'not waiting to publish') }
      })
    })
    const queue = new PublishQueue(fake)
    queue.consider([recording('a', '1', 'approved')], true)
    await settle(queue)
    await settle(queue)
    expect(fake.startExport).toHaveBeenCalledTimes(2)
    expect(fake.mark).not.toHaveBeenCalled()
  })
})
