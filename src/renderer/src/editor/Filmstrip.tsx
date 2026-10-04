import { useEffect, useRef } from 'react'

interface Props {
  url: string
  durationMs: number
  /** Width ÷ height of the video. */
  aspect: number
}

/** Waits for the thumbnails to be redrawn until resizing settles. */
const RESIZE_SETTLE_MS = 200

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true })
    target.addEventListener('error', () => reject(new Error('media error')), { once: true })
  })
}

/**
 * A strip of thumbnails along a timeline lane: each one shows the frame at
 * the instant under its left edge. It is drawn progressively by seeking a
 * throwaway video element, which is released as soon as the strip is done.
 */
export function Filmstrip({ url, durationMs, aspect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let generation = 0
    let settle: ReturnType<typeof setTimeout> | undefined

    const draw = async (): Promise<void> => {
      const current = ++generation
      const width = element.clientWidth
      const height = element.clientHeight
      const context = element.getContext('2d')
      if (!context || width === 0 || height === 0 || durationMs <= 0) return

      const ratio = window.devicePixelRatio || 1
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
      const thumbnailWidth = height * aspect
      const count = Math.ceil(width / thumbnailWidth)

      const video = document.createElement('video')
      video.muted = true
      video.preload = 'auto'
      video.src = url
      try {
        await once(video, 'loadeddata')
        for (let index = 0; index < count && current === generation; index++) {
          const seconds = ((index * thumbnailWidth) / width) * (durationMs / 1000)
          video.currentTime = Math.min(seconds, Math.max(0, video.duration - 0.05))
          await once(video, 'seeked')
          if (current !== generation) break
          context.drawImage(video, index * thumbnailWidth * ratio, 0, thumbnailWidth * ratio, height * ratio)
        }
      } catch {
        // No thumbnails is a cosmetic loss; the lane still works.
      } finally {
        video.removeAttribute('src')
        video.load()
      }
    }

    void draw()
    const observer = new ResizeObserver(() => {
      clearTimeout(settle)
      settle = setTimeout(() => void draw(), RESIZE_SETTLE_MS)
    })
    observer.observe(element)
    return () => {
      generation += 1
      clearTimeout(settle)
      observer.disconnect()
    }
  }, [url, durationMs, aspect])

  return <canvas ref={canvas} className="filmstrip" />
}
