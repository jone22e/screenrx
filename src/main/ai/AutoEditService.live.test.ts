import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssistantEditState } from '@shared/models/assistant'
import type { AutoEditProgress } from '@shared/models/autoEdit'
import type { Logger } from '../logging/logger'
import { SessionStore } from '../recording/SessionStore'
import { AiCliService } from './AiCliService'
import { defaultAiSearchDirs } from './cliProcess'
import { AutoEditService } from './AutoEditService'

const logger: Logger = { debug() {}, info: (message, data) => console.log(message, data), warn: (message, data) => console.warn(message, data), error: (message, data) => console.error(message, data) }

/**
 * The automatic edit against the real tools, on one of the user's own
 * recordings. Not part of the normal run: it spends quota (one director
 * call and up to five agent calls) and takes about a minute.
 *
 *   SCREENRX_AI_LIVE=1 SCREENRX_AI_SESSION=recording-… npx vitest run src/main/ai/AutoEditService.live
 */
describe.runIf(process.env['SCREENRX_AI_LIVE'] === '1' && Boolean(process.env['SCREENRX_AI_SESSION']))('AutoEditService with the installed tools', () => {
  it('plans and edits a real recording', async () => {
    const sessionId = process.env['SCREENRX_AI_SESSION'] as string
    const sessions = new SessionStore(path.join(os.homedir(), 'Movies', 'ScreenRx'), logger)
    const manifest = await sessions.read(sessionId)
    expect(manifest).not.toBeNull()
    const screen = manifest!.assets.screen!
    const edit: AssistantEditState = {
      durationMs: screen.durationMs,
      cuts: [],
      zooms: [],
      speed: 1,
      speedRegions: [],
      hasCaptions: true,
      captionsVisible: true,
      captionLanguage: null,
      captionLength: 'medium',
      captionMode: 'block',
      backgroundId: 'aurora',
      exportPreset: 'custom',
      hasWebcam: manifest!.assets.webcam !== undefined,
      webcamVisible: true,
      hasSystemAudio: manifest!.assets.systemAudio !== undefined,
      microphoneMuted: false,
      systemAudioMuted: false,
      microphoneVolume: 1,
      systemAudioVolume: 1,
      music: null
    }
    const ai = new AiCliService({ logger, searchDirs: defaultAiSearchDirs(process.env, os.homedir()), env: process.env })
    const progress: AutoEditProgress[] = []
    const service = new AutoEditService({ ai, sessions, logger, onProgress: (entry) => progress.push(entry) })
    const startedAt = Date.now()
    const result = await service.run(
      sessionId,
      { brief: { preset: 'reels', targetDurationSec: 60, tone: 'tutorial direto', roles: ['cutter', 'camera', 'captioner', 'sound', 'art'] }, edit },
      { provider: 'claude', model: process.env['SCREENRX_AI_MODEL'] ?? '', effort: 'medium' }
    )
    const lines = [`=== total ${Math.round((Date.now() - startedAt) / 1000)} s ===`, JSON.stringify({ plan: result.plan, progress }, null, 2)]
    for (const worker of result.workers) {
      lines.push(`\n--- ${worker.role} (${Math.round(worker.elapsedMs / 1000)} s) ${worker.error ?? worker.notes}`)
      for (const entry of worker.actions) lines.push(`${JSON.stringify(entry.action)} — ${entry.reason}`)
    }
    const report = lines.join('\n')
    console.log(report)
    // Also written to a file, so the run can be read after vitest is done with it.
    const out = process.env['SCREENRX_AI_OUT']
    if (out) await writeFile(out, report, 'utf8')
    expect(result.plan.workers.length).toBeGreaterThan(0)
    expect(result.workers.some((worker) => worker.actions.length > 0)).toBe(true)
  }, 600_000)
})
