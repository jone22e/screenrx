import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatClock } from '@shared/format'
import type { AppError } from '@shared/models/errors'
import { INSTAGRAM_LIMITS, hashtagCount } from '@shared/models/instagram'
import type { CaptionSuggestion } from '@shared/models/instagram'
import type { RecordingSummary } from '@shared/models/session'
import { aiSettings, currentAiChoice } from '../common/aiSettings'
import { instagramAccount } from '../common/instagramAccount'
import { openSettings } from '../common/settingsScreen'
import { InstagramIcon, SparklesIcon } from './icons'

interface Props {
  /** One recording, or the episodes of a series. */
  recordings: RecordingSummary[]
  /** Shown as the heading when approving a series. */
  series: string | null
  onClose: () => void
}

/**
 * Approving for Instagram: a caption per video (written by hand or by the
 * AI from what is said), then "Aprovar e publicar" puts them in the queue,
 * which makes each Reels file and posts it, in order.
 */
export function PublishDialog({ recordings, series, onClose }: Props) {
  const account = useSyncExternalStore(instagramAccount.subscribe, instagramAccount.getState)
  const ai = useSyncExternalStore(aiSettings.subscribe, aiSettings.getState)
  const current = currentAiChoice(ai)
  // A recording approved before (one that failed, say) keeps its caption.
  const [captions, setCaptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(recordings.flatMap((recording) => (recording.publish?.caption ? [[recording.id, recording.publish.caption]] : [])))
  )
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set())
  // The topic each caption is researched for (empty: the AI decides), and what the research found.
  const [topics, setTopics] = useState<Record<string, string>>({})
  const [research, setResearch] = useState<Record<string, CaptionSuggestion>>({})
  const [error, setError] = useState<AppError | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void instagramAccount.load()
    void aiSettings.load()
  }, [])

  const tooLong = (recording: RecordingSummary): boolean => recording.durationMs > INSTAGRAM_LIMITS.maxDurationMs
  const usable = recordings.filter((recording) => !tooLong(recording) && recording.durationMs >= INSTAGRAM_LIMITS.minDurationMs)
  const connected = account?.account != null

  const suggest = async (ids: readonly string[]): Promise<void> => {
    if (!current) return
    setError(null)
    setWriting((busy) => new Set([...busy, ...ids]))
    // One after the other: the AI tools take one question at a time per caption anyway.
    for (const id of ids) {
      const answer = await window.screenrx.instagram.suggestCaption(id, current.choice, topics[id] ?? '')
      setWriting((busy) => new Set([...busy].filter((entry) => entry !== id)))
      if (answer.ok) {
        const found = answer.value
        setCaptions((all) => ({ ...all, [id]: found.caption }))
        setResearch((all) => ({ ...all, [id]: found }))
        setTopics((all) => (all[id]?.trim() ? all : { ...all, [id]: found.topic }))
      }
      else if (answer.error.code !== 'ai-cancelled') {
        setError(answer.error)
        setWriting(new Set())
        return
      }
    }
  }

  const approve = (): void => {
    setSaving(true)
    setError(null)
    void window.screenrx.instagram
      .approve(usable.map((recording) => ({ sessionId: recording.id, caption: captions[recording.id] ?? '' })))
      .then((result) => {
        if (result.ok) onClose()
        else setError(result.error)
      })
      .finally(() => setSaving(false))
  }

  const busy = writing.size > 0 || saving

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog publish-dialog" role="dialog" aria-modal="true" aria-label="Publicar no Instagram">
        <h2 className="dialog-title">
          <InstagramIcon /> {series ? `Publicar “${series}” no Instagram` : 'Publicar no Instagram'}
        </h2>

        <div className="publish-account">
          {account === null ? (
            <span className="muted">Verificando a conta…</span>
          ) : connected ? (
            <>
              <span>
                Reels em <strong>@{account.account?.username}</strong>
              </span>
            </>
          ) : (
            <>
              <span>Nenhuma conta do Instagram conectada.</span>
              <button className="panel-button panel-button-small" onClick={openSettings}>
                Conectar
              </button>
            </>
          )}
          {recordings.length > 1 && current && (
            <button className="panel-button panel-button-small publish-suggest-all" disabled={busy} onClick={() => void suggest(usable.map((recording) => recording.id))}>
              <SparklesIcon /> Escrever todas com IA
            </button>
          )}
        </div>

        <ol className="publish-list">
          {recordings.map((recording, index) => {
            const caption = captions[recording.id] ?? ''
            const tags = hashtagCount(caption)
            const blocked = tooLong(recording) || recording.durationMs < INSTAGRAM_LIMITS.minDurationMs
            return (
              <li key={recording.id} className="publish-item" data-blocked={blocked}>
                <div className="publish-item-head">
                  {recording.thumbnailUrl && <img className="publish-thumb" src={recording.thumbnailUrl} alt="" />}
                  <span className="publish-item-title">
                    {recordings.length > 1 && <span className="episode-number">{index + 1}</span>}
                    {recording.title}
                  </span>
                  <span className="publish-item-meta">{formatClock(recording.durationMs)}</span>
                  {current && !blocked && (
                    <button
                      className="icon-button icon-button-ai"
                      aria-label={`Escrever a legenda de ${recording.title} com IA`}
                      title="Pesquisar o que está em alta sobre o tema e escrever a legenda e as hashtags com IA"
                      disabled={busy}
                      onClick={() => void suggest([recording.id])}
                    >
                      <SparklesIcon />
                    </button>
                  )}
                </div>
                {!blocked && (
                  <label className="publish-topic">
                    <span>Tema</span>
                    <input
                      type="text"
                      value={topics[recording.id] ?? ''}
                      maxLength={80}
                      placeholder="A IA descobre pelo vídeo — ex.: GTA 6"
                      disabled={writing.has(recording.id) || saving}
                      aria-label={`Tema de ${recording.title}`}
                      onChange={(event) => setTopics((all) => ({ ...all, [recording.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && current && !busy) void suggest([recording.id])
                      }}
                    />
                  </label>
                )}
                {blocked ? (
                  <p className="dialog-warning">
                    {tooLong(recording) ? `Reels pela API vão até ${formatClock(INSTAGRAM_LIMITS.maxDurationMs)}.` : 'Curto demais para um Reel (mínimo 3 s).'} Fica de fora.
                  </p>
                ) : (
                  <label className="publish-caption">
                    <textarea
                      value={caption}
                      rows={recordings.length > 1 ? 3 : 6}
                      maxLength={INSTAGRAM_LIMITS.captionChars}
                      placeholder={writing.has(recording.id) ? 'Pesquisando o que está em alta e escrevendo…' : 'Legenda do Reel'}
                      disabled={writing.has(recording.id) || saving}
                      aria-label={`Legenda de ${recording.title}`}
                      onChange={(event) => setCaptions((all) => ({ ...all, [recording.id]: event.target.value }))}
                    />
                    <span className="publish-count" data-over={tags > INSTAGRAM_LIMITS.hashtags}>
                      {caption.length}/{INSTAGRAM_LIMITS.captionChars}
                      {tags > 0 && ` · ${tags} hashtag${tags === 1 ? '' : 's'}`}
                    </span>
                  </label>
                )}
                {research[recording.id] && <TrendLine suggestion={research[recording.id] as CaptionSuggestion} />}
              </li>
            )
          })}
        </ol>

        {error && (
          <p className="dialog-error" role="alert">
            {error.message}
          </p>
        )}

        <div className="dialog-actions">
          <span className="publish-note muted" title="Cada vídeo é exportado em 9:16 com as configurações de Reels e enviado na ordem da série. O app precisa ficar aberto até terminar.">
            {usable.length === 1 ? '1 Reel' : `${usable.length} Reels`} · 9:16
          </span>
          <button className="panel-button" disabled={saving} onClick={onClose}>
            Cancelar
          </button>
          <button className="panel-button panel-button-primary" disabled={busy || !connected || usable.length === 0} onClick={approve}>
            Aprovar e publicar
          </button>
        </div>
      </div>
    </div>
  )
}

/** Asks the library to open the dialog, from a card, a row or a shelf. */
class PublishRequest {
  private request: { ids: string[]; series: string | null } | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): { ids: string[]; series: string | null } | null => this.request

  open(ids: string[], series: string | null): void {
    this.request = ids.length > 0 ? { ids, series } : null
    for (const listener of this.listeners) listener()
  }

  close(): void {
    this.open([], null)
  }
}

export const publishRequest = new PublishRequest()

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** What the research found, under the caption: the terms in demand (why, on hover) and where it looked. */
function TrendLine({ suggestion }: { suggestion: CaptionSuggestion }) {
  const { trends, sources } = suggestion
  if (trends.length === 0 && sources.length === 0) return null
  return (
    <div className="publish-trends">
      {trends.length > 0 && <span className="publish-trends-label">Em alta</span>}
      {trends.map((trend) => (
        <span key={trend.term} className="publish-trend" title={trend.why}>
          {trend.term}
        </span>
      ))}
      <span className="publish-sources" title={sources.length > 0 ? sources.map(hostOf).join('\n') : 'A ferramenta de IA não conseguiu pesquisar na web; os termos vêm do que ela já sabe.'}>
        {sources.length > 0 ? `${sources.length} ${sources.length === 1 ? 'fonte' : 'fontes'}` : 'sem pesquisa na web'}
      </span>
    </div>
  )
}
