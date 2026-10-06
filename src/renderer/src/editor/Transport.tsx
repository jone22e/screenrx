import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EXPORT_CONFIG } from '@engine/export/exportConfig'
import { sourceTimeToTimelineTime } from '@engine/time/timeMapping'
import { formatTimecode } from '@shared/format'
import type { EditorStore } from './EditorStore'
import type { PreviewPlayer } from './PreviewPlayer'
import { PauseIcon, PlayIcon, SkipStartIcon } from './icons'

interface Props {
  player: PreviewPlayer
  store: EditorStore
}

const speedLabel = (speed: number): string => `${String(speed).replace('.', ',')}×`

/**
 * Playback controls under the preview. Times are in the edited timeline, cuts
 * removed. The speed chosen here is the speed of the finished video: the
 * preview plays at it and the export uses it.
 */
export function Transport({ player, store }: Props) {
  const { timeMap, exportSettings } = useSyncExternalStore(store.subscribe, store.getState)
  const { speed } = exportSettings
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
      <label className="transport-speed" data-changed={speed !== 1} title="Velocidade do vídeo, no preview e no arquivo exportado">
        <span>Velocidade</span>
        <select
          aria-label="Velocidade do vídeo"
          value={speed}
          onChange={(event) => {
            store.setExportSettings({ speed: Number(event.target.value) })
            // Focus goes back to the editor, so the space bar keeps playing and pausing.
            event.target.blur()
          }}
        >
          {EXPORT_CONFIG.speeds.map((option) => (
            <option key={option} value={option}>
              {speedLabel(option)}
            </option>
          ))}
        </select>
      </label>
      {speed !== 1 && (
        <span className="transport-output" title="Duração do vídeo exportado nesta velocidade">
          vídeo final: {formatTimecode(timeMap.timelineDurationMs / speed)}
        </span>
      )}
    </div>
  )
}
