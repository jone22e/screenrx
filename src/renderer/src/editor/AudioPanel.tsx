import { useState, useSyncExternalStore } from 'react'
import { formatTimecode } from '@shared/format'
import type { EditorSession } from '@shared/models/editor'
import type { AudioTrackKind, MusicDucking } from '@shared/models/project'
import { MUSIC_LIMITS } from '@shared/models/project'
import type { EditorStore } from './EditorStore'
import { MicIcon, MusicIcon, SpeakerIcon, TrashIcon } from './icons'
import { Section, Segmented, Slider } from './panelControls'

interface Props {
  session: EditorSession
  store: EditorStore
}

const TRACKS: Record<AudioTrackKind, { label: string; icon: React.ReactNode }> = {
  microphone: { label: 'Microfone', icon: <MicIcon /> },
  systemAudio: { label: 'Som do sistema', icon: <SpeakerIcon /> }
}

const DUCKINGS: ReadonlyArray<{ value: MusicDucking; label: string }> = [
  { value: 'off', label: 'Não' },
  { value: 'light', label: 'Um pouco' },
  { value: 'strong', label: 'Bastante' }
]

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

/**
 * The sound of the finished video: how loud each recorded track plays, the
 * music under them, and the final loudness.
 */
export function AudioPanel({ session, store }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { audio, music, musicTrack, exportSettings } = state
  const dub = state.dubs.find((track) => track.language === state.dub.language) ?? null
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const chooseMusic = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const result = await window.screenrx.music.import(session.sessionId).catch(() => null)
    setBusy(false)
    if (!result?.ok) {
      setNotice(result?.error.message ?? 'Não foi possível trazer a música.')
      return
    }
    if (result.value) store.setMusicTrack(result.value)
  }

  const removeMusic = async (): Promise<void> => {
    setBusy(true)
    const result = await window.screenrx.music.remove(session.sessionId).catch(() => null)
    setBusy(false)
    if (!result?.ok) {
      setNotice(result?.error.message ?? 'Não foi possível remover a música.')
      return
    }
    store.setMusicTrack(null)
  }

  return (
    <>
      {session.audio.length === 0 ? (
        <Section title="Gravação">
          <p className="panel-hint">Sem áudio. A música abaixo pode ser o som do vídeo.</p>
        </Section>
      ) : (
        session.audio.map((track) => {
          const settings = audio[track.kind]
          const replaced = track.kind === 'microphone' && dub !== null
          return (
            <Section key={track.kind} title={TRACKS[track.kind].label}>
              {replaced && <p className="panel-hint">A dublagem em uso toca no lugar do microfone.</p>}
              <label className="check">
                <input
                  type="checkbox"
                  checked={!settings.muted}
                  disabled={replaced}
                  onChange={(event) => store.setTrackMuted(track.kind, !event.target.checked)}
                />
                <span>Ouvir no vídeo</span>
              </label>
              <Slider
                label="Volume"
                value={percent(settings.volume)}
                min={0}
                max={1}
                step={0.01}
                current={settings.volume}
                onChange={(volume) => store.setTrackVolume(track.kind, volume, `volume:${track.kind}`)}
                onCommit={() => store.endGesture()}
              />
            </Section>
          )
        })
      )}

      <Section title="Música de fundo" help="Uma trilha por baixo da gravação, do começo ao fim do vídeo pronto; o arquivo original não muda. Na exportação a música desce quando alguém fala (no preview, só depois das legendas).">
        {musicTrack ? (
          <>
            <div className="music-file">
              <MusicIcon />
              <span className="music-name" title={musicTrack.name}>
                {musicTrack.name}
              </span>
              <span className="music-length">{formatTimecode(musicTrack.durationMs)}</span>
              <button
                className="region-row-remove"
                aria-label="Remover a música"
                title="Remover a música desta gravação"
                disabled={busy}
                onClick={() => void removeMusic()}
              >
                <TrashIcon />
              </button>
            </div>
            <button className="panel-button" disabled={busy} onClick={() => void chooseMusic()}>
              <MusicIcon /> Trocar a música…
            </button>
          </>
        ) : (
          <>
            <button className="panel-button panel-button-primary" disabled={busy} onClick={() => void chooseMusic()}>
              <MusicIcon /> {busy ? 'Trazendo…' : 'Escolher música…'}
            </button>
          </>
        )}
        {notice && <p className="panel-notice">{notice}</p>}

        {music && musicTrack && (
          <>
            <Slider
              label="Volume"
              value={percent(music.volume)}
              min={0}
              max={1}
              step={0.01}
              current={music.volume}
              onChange={(volume) => store.setMusic({ volume }, 'music-volume')}
              onCommit={() => store.endGesture()}
            />
            <Segmented
              label="Abaixar quando alguém fala"
              value={music.ducking}
              options={DUCKINGS}
              onChange={(ducking) => store.setMusic({ ducking })}
            />
            <label className="check">
              <input type="checkbox" checked={music.loop} onChange={(event) => store.setMusic({ loop: event.target.checked })} />
              <span>Repetir até o fim do vídeo</span>
            </label>
            <Slider
              label="Entrada"
              value={seconds(music.fadeInMs)}
              min={0}
              max={MUSIC_LIMITS.maxFadeMs}
              step={100}
              current={music.fadeInMs}
              onChange={(fadeInMs) => store.setMusic({ fadeInMs }, 'music-fade-in')}
              onCommit={() => store.endGesture()}
            />
            <Slider
              label="Saída"
              value={seconds(music.fadeOutMs)}
              min={0}
              max={MUSIC_LIMITS.maxFadeMs}
              step={100}
              current={music.fadeOutMs}
              onChange={(fadeOutMs) => store.setMusic({ fadeOutMs }, 'music-fade-out')}
              onCommit={() => store.endGesture()}
            />
          </>
        )}
      </Section>

      <Section title="Volume final" help="Deixa a exportação no volume que Instagram, TikTok e YouTube esperam: nem baixo ao lado de outros posts, nem alto a ponto de ser abaixado. O preview não muda.">
        <label className="check">
          <input
            type="checkbox"
            checked={exportSettings.loudness === 'social'}
            onChange={(event) => store.setExportSettings({ loudness: event.target.checked ? 'social' : 'off' })}
          />
          <span>Ajustar para redes sociais (−14 LUFS)</span>
        </label>
      </Section>
    </>
  )
}
