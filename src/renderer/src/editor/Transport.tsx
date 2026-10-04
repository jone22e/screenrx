import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sourceTimeToTimelineTime } from '@engine/time/timeMapping'
import { formatTimecode } from '@shared/format'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { PauseIcon, PlayIcon, SkipStartIcon } from './icons'

interface Props {
  player: PreviewPlayer
  store: EditorStore
}

/** Playback controls under the preview. Times are in the edited timeline, cuts removed. */
export function Transport({ player, store }: Props) {
  const { timeMap } = useSyncExternalStore(store.subscribe, store.getState)
  const timeLabel = useRef<HTMLSpanElement>(null)
  const [playing, setPlaying] = useState(player.playing)

  // The clock follows the player directly, without re-rendering React.
  useEffect(() => {
    const stopTime = player.onTime((sourceMs) => {
      if (timeLabel.current) {
        timeLabel.current.textContent = formatTimecode(sourceTimeToTimelineTime(timeMap, sourceMs))
      }
    })
    const stopPlaying = player.onPlayingChange(setPlaying)
    return () => {
      stopTime()
      stopPlaying()
    }
  }, [player, timeMap])

  return (
    <div className="transport">
      <button
        className="transport-button"
        aria-label="Voltar ao início"
        title="Voltar ao início"
        onClick={() => player.seek(timeMap.segments[0]?.sourceStartMs ?? 0)}
      >
        <SkipStartIcon />
      </button>
      <button
        className="transport-button transport-play"
        aria-label={playing ? 'Pausar' : 'Reproduzir'}
        title={playing ? 'Pausar (espaço)' : 'Reproduzir (espaço)'}
        onClick={() => player.toggle()}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span className="transport-time">
        <span ref={timeLabel}>00:00,0</span>
        <span className="transport-duration"> / {formatTimecode(timeMap.timelineDurationMs)}</span>
      </span>
    </div>
  )
}
