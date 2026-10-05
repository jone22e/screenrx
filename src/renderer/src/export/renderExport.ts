import { cueAt } from '@engine/captions/captionCues'
import { frameSourceTimeMs } from '@engine/export/exportPlan'
import { buildTimeMap } from '@engine/time/timeMapping'
import { cameraAt } from '@engine/zoom/zoomCamera'
import type { EditorSession } from '@shared/models/editor'
import type { AppError } from '@shared/models/errors'
import type { ExportJob } from '@shared/models/export'
import type { Project } from '@shared/models/project'
import { zoomsOf } from '@shared/models/project'
import { composeFrame } from '../rendering/composeFrame'
import { TrackFrameReader } from './TrackFrameReader'

const BYTES_PER_PIXEL = 4

export class ExportAbortedError extends Error {
  constructor() {
    super('Export aborted')
    this.name = 'ExportAbortedError'
  }
}

export class ExportFailedError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.detail ?? appError.code)
    this.name = 'ExportFailedError'
  }
}

/**
 * Renders every frame of an export and streams it to the encoder.
 *
 * For each output frame the recording's instant is found by mapping
 * output time → timeline time → source time, so cuts and the global speed
 * are applied while rendering: every frame is drawn once, at its final
 * position, and encoded once. Frames are drawn by `composeFrame` with the
 * camera from `cameraAt` — the very code the preview runs.
 */
export async function renderExport(
  job: ExportJob,
  session: EditorSession,
  project: Project,
  onProgress: (framesDone: number) => void,
  signal: AbortSignal
): Promise<void> {
  const { plan, exportId } = job
  const api = window.screenrx.export
  const map = buildTimeMap(session.durationMs, project.effects)
  const zooms = zoomsOf(project)
  const { captions } = project
  const output = { width: plan.width, height: plan.height }

  // Composited on the GPU, like the preview; each finished frame is then read back once.
  const canvas = new OffscreenCanvas(plan.width, plan.height)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Canvas 2D is unavailable')
  context.imageSmoothingQuality = 'high'
  const pixels = new Uint8Array(plan.width * plan.height * BYTES_PER_PIXEL)

  const screen = new TrackFrameReader(job.screen, (offset, length) =>
    api.readChunk(exportId, 'screen', offset, length)
  )
  const webcam = job.webcam
    ? new TrackFrameReader(job.webcam, (offset, length) => api.readChunk(exportId, 'webcam', offset, length))
    : null

  try {
    for (let index = 0; index < plan.frameCount; index++) {
      if (signal.aborted) throw new ExportAbortedError()
      const sourceMs = frameSourceTimeMs(plan, map, index)
      const frame = await screen.frameAt(sourceMs * 1000)
      if (!frame) throw new Error('The screen track has no frames')
      const webcamFrame = webcam ? await webcam.frameAt(sourceMs * 1000) : null
      const cue = captions.visible ? cueAt(captions.cues, sourceMs) : null

      composeFrame(context, output, {
        screen: frame,
        screenSize: { width: frame.displayWidth, height: frame.displayHeight },
        webcam: webcamFrame
          ? {
              image: webcamFrame,
              size: { width: webcamFrame.displayWidth, height: webcamFrame.displayHeight },
              settings: project.webcam
            }
          : null,
        camera: cameraAt(zooms, sourceMs),
        background: project.background,
        caption: cue ? { text: cue.text, style: captions.style } : null
      })

      const rendered = new VideoFrame(canvas, { timestamp: 0 })
      try {
        await rendered.copyTo(pixels, { format: 'RGBA' })
      } finally {
        rendered.close()
      }
      // Awaiting each frame is the back-pressure: nothing piles up in memory.
      const written = await api.writeFrame(exportId, pixels)
      if (!written.ok) throw new ExportFailedError(written.error)
      onProgress(index + 1)
    }
  } finally {
    screen.close()
    webcam?.close()
  }
}
