import { describe, expect, it } from 'vitest'
import type { CaptureEngine, CaptureInterruption, StartCaptureRequest } from './CaptureEngine'
import type { MeetingCapture } from './RoutingCaptureEngine'
import { RoutingCaptureEngine } from './RoutingCaptureEngine'

const MEETING_WINDOW = 2_000_000_007

function fakes() {
  const calls: string[] = []
  const interrupt: Array<(i: CaptureInterruption) => void> = []
  const result = (label: string) => ({ label }) as never
  const platform = {
    getPermissions: async () => result('permissions'),
    start: async () => (calls.push('platform.start'), result('platform-start')),
    pause: async () => (calls.push('platform.pause'), result('mark')),
    resume: async () => (calls.push('platform.resume'), result('mark')),
    stop: async () => (calls.push('platform.stop'), result('platform-stop')),
    onInterrupted: (l: (i: CaptureInterruption) => void) => (interrupt.push(l), () => undefined),
    dispose: async () => undefined
  } as unknown as CaptureEngine
  const meeting: MeetingCapture = {
    owns: (id) => id === MEETING_WINDOW,
    start: async () => (calls.push('meeting.start'), result('meeting-start')),
    pause: async () => (calls.push('meeting.pause'), result('mark')),
    resume: async () => (calls.push('meeting.resume'), result('mark')),
    stop: async () => (calls.push('meeting.stop'), result('meeting-stop')),
    onInterrupted: (l) => (interrupt.push(l), () => undefined),
    dispose: async () => undefined
  }
  return { calls, interrupt, engine: new RoutingCaptureEngine(platform, meeting) }
}

const request = (source: StartCaptureRequest['source']): StartCaptureRequest => ({ source }) as StartCaptureRequest
const windowSource = (windowId: number) => ({ kind: 'window', windowId }) as StartCaptureRequest['source']
const displaySource = { kind: 'display', displayId: 1 } as StartCaptureRequest['source']

describe('RoutingCaptureEngine', () => {
  it('sends the meeting window to the meeting capture for the whole recording', async () => {
    const { calls, engine } = fakes()
    await engine.start(request(windowSource(MEETING_WINDOW)))
    await engine.pause()
    await engine.resume()
    await engine.stop()
    expect(calls).toEqual(['meeting.start', 'meeting.pause', 'meeting.resume', 'meeting.stop'])
  })

  it('sends displays and system windows to the platform engine', async () => {
    const { calls, engine } = fakes()
    await engine.start(request(displaySource))
    await engine.stop()
    await engine.start(request(windowSource(333_000)))
    await engine.stop()
    expect(calls).toEqual(['platform.start', 'platform.stop', 'platform.start', 'platform.stop'])
  })

  it('goes back to the platform engine after a meeting recording', async () => {
    const { calls, engine } = fakes()
    await engine.start(request(windowSource(MEETING_WINDOW)))
    await engine.stop()
    await engine.start(request(displaySource))
    await engine.pause()
    expect(calls.slice(-2)).toEqual(['platform.start', 'platform.pause'])
  })

  it('reports interruptions from either capture', () => {
    const { interrupt, engine } = fakes()
    const seen: string[] = []
    engine.onInterrupted(() => seen.push('x'))
    for (const listener of interrupt) listener({} as CaptureInterruption)
    expect(seen).toEqual(['x', 'x'])
  })
})
