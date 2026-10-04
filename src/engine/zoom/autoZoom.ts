import type { ZoomEffect } from '@shared/models/project'
import type { InteractionEvent, InteractionType } from '@shared/models/telemetry'
import { AUTO_ZOOM_CONFIG, ZOOM_LIMITS } from './zoomConfig'

/**
 * Interactions that deserve the viewer's attention. Only explicit clicks
 * for now; drags, dwell and text selection can join this analysis later
 * without changing its output type.
 */
const ZOOM_TRIGGERS: ReadonlySet<InteractionType> = new Set(['click', 'doubleClick', 'rightClick'])

interface ClickCluster {
  firstMs: number
  lastMs: number
  sumX: number
  sumY: number
  count: number
}

const isInsideFrame = (event: InteractionEvent): boolean =>
  event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1

function clusterClicks(clicks: InteractionEvent[]): ClickCluster[] {
  const clusters: ClickCluster[] = []
  for (const click of clicks) {
    const current = clusters.at(-1)
    if (current) {
      const closeInTime = click.timeMs - current.lastMs <= AUTO_ZOOM_CONFIG.clickClusterMergeGapMs
      const distance = Math.hypot(
        click.x - current.sumX / current.count,
        click.y - current.sumY / current.count
      )
      if (closeInTime && distance <= AUTO_ZOOM_CONFIG.clickClusterMaxDistance) {
        current.lastMs = click.timeMs
        current.sumX += click.x
        current.sumY += click.y
        current.count += 1
        continue
      }
    }
    clusters.push({
      firstMs: click.timeMs,
      lastMs: click.timeMs,
      sumX: click.x,
      sumY: click.y,
      count: 1
    })
  }
  return clusters
}

/**
 * Turns the recorded clicks into zoom regions: clicks close in time and
 * space share one zoom focused on their centre, padded so the camera
 * arrives before the first click and lingers after the last.
 *
 * Works from telemetry alone — no pixels are analysed.
 */
export function generateAutoZooms(
  interactions: readonly InteractionEvent[],
  durationMs: number,
  createId: () => string
): ZoomEffect[] {
  const clicks = interactions
    .filter((event) => ZOOM_TRIGGERS.has(event.type) && isInsideFrame(event))
    .filter((event) => event.timeMs >= 0 && event.timeMs <= durationMs)
    .sort((a, b) => a.timeMs - b.timeMs)

  const zooms: ZoomEffect[] = []
  for (const cluster of clusterClicks(clicks)) {
    let startMs = Math.max(0, cluster.firstMs - AUTO_ZOOM_CONFIG.paddingBeforeMs)
    const endMs = Math.min(durationMs, cluster.lastMs + AUTO_ZOOM_CONFIG.paddingAfterMs)

    // Paddings of neighbouring zooms may collide; the earlier zoom yields, so
    // the camera pans from one focus straight to the next.
    const previous = zooms.at(-1)
    if (previous && startMs < previous.endMs) {
      startMs = Math.max(startMs, previous.startMs + ZOOM_LIMITS.minDurationMs)
      previous.endMs = startMs
    }
    if (endMs - startMs < ZOOM_LIMITS.minDurationMs) continue

    zooms.push({
      id: createId(),
      type: 'zoom',
      startMs,
      endMs,
      focus: { x: cluster.sumX / cluster.count, y: cluster.sumY / cluster.count },
      scale: AUTO_ZOOM_CONFIG.scale,
      easing: 'easeInOut',
      mode: 'auto'
    })
  }
  return zooms
}

/**
 * Replaces the automatic zooms of a project with freshly generated ones.
 * Zooms the user created or edited are kept, and win over any automatic
 * zoom that would overlap them.
 */
export function regenerateAutoZooms(
  existing: readonly ZoomEffect[],
  interactions: readonly InteractionEvent[],
  durationMs: number,
  createId: () => string
): ZoomEffect[] {
  const manual = existing.filter((zoom) => zoom.mode === 'manual')
  const automatic = generateAutoZooms(interactions, durationMs, createId).filter((candidate) =>
    manual.every((zoom) => candidate.endMs <= zoom.startMs || candidate.startMs >= zoom.endMs)
  )
  return [...manual, ...automatic].sort((a, b) => a.startMs - b.startMs)
}
