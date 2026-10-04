import { useEffect, useRef, useState } from 'react'

interface Props {
  sessionId: string
  track: 'microphone' | 'systemAudio'
}

const COLORS = { microphone: '#7dd3fc', systemAudio: '#c4b5fd' } as const

/** The loudness outline of an audio track, drawn along its timeline lane. */
export function Waveform({ sessionId, track }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.screenrx.editor.waveform(sessionId, track).then((result) => {
      if (!cancelled && result.ok) setPeaks(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, track])

  useEffect(() => {
    const element = canvas.current
    if (!element || !peaks) return

    const draw = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      const context = element.getContext('2d')
      if (!context || width === 0 || height === 0) return
      const ratio = window.devicePixelRatio || 1
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
      context.scale(ratio, ratio)
      context.fillStyle = COLORS[track]

      // One bar every other pixel, as tall as the loudest moment it covers.
      const step = 2
      for (let x = 0; x < width; x += step) {
        const from = Math.floor((x / width) * peaks.length)
        const to = Math.max(from + 1, Math.floor(((x + step) / width) * peaks.length))
        let peak = 0
        for (let index = from; index < to && index < peaks.length; index++) {
          peak = Math.max(peak, peaks[index] ?? 0)
        }
        const bar = Math.max(1, peak * (height - 6))
        context.fillRect(x, (height - bar) / 2, 1, bar)
      }
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    return () => observer.disconnect()
  }, [peaks, track])

  return <canvas ref={canvas} className="waveform" />
}
