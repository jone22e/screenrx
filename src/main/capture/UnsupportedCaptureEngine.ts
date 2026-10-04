import { appError } from '@shared/models/errors'
import type { PermissionReport } from '@shared/models/permissions'
import type { CaptureEngine } from './CaptureEngine'
import { CaptureError } from './CaptureEngine'

function unsupported(): never {
  throw new CaptureError(appError('platform-unsupported', process.platform))
}

/** Stand-in for platforms without a capture engine yet (Windows comes in phase 9). */
export class UnsupportedCaptureEngine implements CaptureEngine {
  getPermissions = async (): Promise<PermissionReport> => ({
    permissions: { screenRecording: 'unsupported', microphone: 'unsupported', camera: 'unsupported' },
    grantee: { name: null, isLauncher: false }
  })
  requestScreenRecordingPermission = this.getPermissions
  requestMediaPermission = this.getPermissions
  listDevices = async () => ({ microphones: [], cameras: [] })
  listSources = async () => unsupported()
  start = async () => unsupported()
  pause = async () => unsupported()
  resume = async () => unsupported()
  stop = async () => unsupported()
  onInterrupted = () => () => undefined
  dispose = async () => undefined
}
