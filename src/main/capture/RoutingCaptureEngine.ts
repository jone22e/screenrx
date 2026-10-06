import type { Unsubscribe } from '@shared/ipc/contract'
import type { CaptureSourceCatalog } from '@shared/models/capture'
import type { CaptureDevices } from '@shared/models/devices'
import type { MediaPermissionKind, PermissionReport } from '@shared/models/permissions'
import type {
  CaptureEngine,
  CaptureInterruption,
  CaptureResult,
  CaptureStartInfo,
  CaptureTimeMark,
  ListSourcesOptions,
  StartCaptureRequest
} from './CaptureEngine'

/** What records a meeting drawn off screen; the same shape as the engine for what the engine does not cover. */
export interface MeetingCapture {
  /** Whether `windowId` is the meeting window rather than a window of the system. */
  owns(windowId: number): boolean
  start(request: StartCaptureRequest): Promise<CaptureStartInfo>
  pause(): Promise<CaptureTimeMark>
  resume(): Promise<CaptureTimeMark>
  stop(): Promise<CaptureResult>
  onInterrupted(listener: (interruption: CaptureInterruption) => void): Unsubscribe
  dispose(): Promise<void>
}

/**
 * Sends a recording to the capture that can do it: the meeting window to the off-screen capture, everything
 * else (displays and the system's windows) to the platform engine. Everything above it sees a single engine.
 */
export class RoutingCaptureEngine implements CaptureEngine {
  private route: 'platform' | 'meeting' = 'platform'

  constructor(
    private readonly platform: CaptureEngine,
    private readonly meeting: MeetingCapture
  ) {}

  getPermissions(): Promise<PermissionReport> {
    return this.platform.getPermissions()
  }

  requestScreenRecordingPermission(): Promise<PermissionReport> {
    return this.platform.requestScreenRecordingPermission()
  }

  requestMediaPermission(kind: MediaPermissionKind): Promise<PermissionReport> {
    return this.platform.requestMediaPermission(kind)
  }

  listDevices(): Promise<CaptureDevices> {
    return this.platform.listDevices()
  }

  listSources(options: ListSourcesOptions): Promise<CaptureSourceCatalog> {
    return this.platform.listSources(options)
  }

  async start(request: StartCaptureRequest): Promise<CaptureStartInfo> {
    const forMeeting = request.source.kind === 'window' && this.meeting.owns(request.source.windowId)
    const info = await (forMeeting ? this.meeting.start(request) : this.platform.start(request))
    this.route = forMeeting ? 'meeting' : 'platform'
    return info
  }

  pause(): Promise<CaptureTimeMark> {
    return this.current().pause()
  }

  resume(): Promise<CaptureTimeMark> {
    return this.current().resume()
  }

  async stop(): Promise<CaptureResult> {
    const engine = this.current()
    try {
      return await engine.stop()
    } finally {
      this.route = 'platform'
    }
  }

  onInterrupted(listener: (interruption: CaptureInterruption) => void): Unsubscribe {
    const unsubscribers = [this.platform.onInterrupted(listener), this.meeting.onInterrupted(listener)]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([this.meeting.dispose(), this.platform.dispose()])
  }

  private current(): Pick<CaptureEngine, 'pause' | 'resume' | 'stop'> {
    return this.route === 'meeting' ? this.meeting : this.platform
  }
}
