import { spawn } from 'node:child_process'
import { createLogger } from '../logging/logger'
import type { CaptureEngine } from './CaptureEngine'
import { UnsupportedCaptureEngine } from './UnsupportedCaptureEngine'
import { HelperProcess } from './macos/HelperProcess'
import { MacCaptureEngine } from './macos/MacCaptureEngine'

export interface CaptureEngineOptions {
  /** Absolute path of the native helper binary for this platform. */
  helperPath: string
}

/** The only place that knows which capture implementation a platform uses. */
export function createCaptureEngine(options: CaptureEngineOptions): CaptureEngine {
  const logger = createLogger('capture')
  if (process.platform === 'darwin') {
    const helper = new HelperProcess(
      () => spawn(options.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] }),
      logger
    )
    return new MacCaptureEngine(helper, logger)
  }
  logger.warn('no capture engine for this platform', { platform: process.platform })
  return new UnsupportedCaptureEngine()
}
