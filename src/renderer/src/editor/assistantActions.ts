import { formatTimecode } from '@shared/format'
import type { AssistantAction } from '@shared/models/assistant'
import type { CaptionLanguage } from '@shared/models/project'
import { CAPTION_LANGUAGE_NAMES } from '@engine/captions/captionTranslation'
import { platformPreset } from '@engine/export/platformPresets'
import { BACKGROUND_PRESETS } from '@engine/rendering/backgrounds'
import type { EditorStore } from './EditorStore'
import { FRAME_ASPECT_LABELS } from './frameAspects'

/** What became of each action, in words for the chat. */
export interface AppliedActions {
  done: string[]
  skipped: string[]
}

const span = (action: { startMs: number; endMs: number }): string =>
  `${formatTimecode(action.startMs)}–${formatTimecode(action.endMs)}`

const TRACK_LABELS = { microphone: 'microfone', systemAudio: 'som do sistema' } as const
const LENGTH_LABELS = { word: 'uma palavra', pair: 'duas ou três palavras', short: 'curto', medium: 'médio', long: 'longo' } as const
const MODE_LABELS = { block: 'em bloco', highlight: 'palavra em destaque', reveal: 'palavra por palavra' } as const
const ANIMATION_LABELS = { none: 'sem animação', pop: 'com pop', fade: 'com fade' } as const

/**
 * Makes the edits the assistant asked for, as one undo step. A translation
 * is the one edit that takes time and another AI call: it is started and
 * finishes on its own, like from the Legendas tab.
 */
export function applyAssistantActions(
  store: EditorStore,
  actions: readonly AssistantAction[],
  translate: (language: CaptionLanguage) => void
): AppliedActions {
  const result: AppliedActions = { done: [], skipped: [] }
  const did = (label: string, ok: boolean): void => void (ok ? result.done : result.skipped).push(label)

  store.runAsOneStep(() => {
    for (const action of actions) {
      switch (action.type) {
        case 'cut':
          did(`Corte ${span(action)}`, store.cutStretch(action))
          break
        case 'uncut': {
          const trims = store.getState().trims.filter((trim) => trim.startMs < action.endMs && trim.endMs > action.startMs)
          for (const trim of trims) store.removeTrim(trim.id)
          did(`Corte desfeito em ${span(action)}`, trims.length > 0)
          break
        }
        case 'zoom':
          did(`Zoom ${span(action)}`, store.addZoomSpan(action, action.scale))
          break
        case 'remove-zoom': {
          const zooms = store.getState().zooms.filter((zoom) => zoom.startMs < action.endMs && zoom.endMs > action.startMs)
          for (const zoom of zooms) store.removeZoom(zoom.id)
          did(`Zoom removido em ${span(action)}`, zooms.length > 0)
          break
        }
        case 'speed':
          store.setExportSettings({ speed: action.speed })
          did(`Velocidade ${String(action.speed).replace('.', ',')}×`, true)
          break
        case 'speed-region':
          did(`Trecho ${span(action)} a ${String(action.speed).replace('.', ',')}×`, store.addSpeedSpan(action, action.speed))
          break
        case 'captions': {
          const ok = store.getState().captions.cues.length > 0
          if (ok) store.setCaptionsVisible(action.visible)
          did(action.visible ? 'Legendas mostradas' : 'Legendas ocultas', ok)
          break
        }
        case 'caption-language': {
          if (action.language === null) {
            did('Legendas no idioma original', store.setCaptionLanguage(null))
          } else if (store.setCaptionLanguage(action.language)) {
            did(`Legendas em ${CAPTION_LANGUAGE_NAMES[action.language].label.toLowerCase()}`, true)
          } else if (store.getState().captions.cues.length > 0) {
            translate(action.language)
            did(`Traduzindo as legendas para ${CAPTION_LANGUAGE_NAMES[action.language].label.toLowerCase()}…`, true)
          } else {
            did('Legendas traduzidas', false)
          }
          break
        }
        case 'caption-length': {
          const ok = store.getState().captions.cues.length > 0
          if (ok) store.setCaptionLength(action.length)
          did(`Texto por legenda: ${LENGTH_LABELS[action.length]}`, ok)
          break
        }
        case 'caption-mode':
          store.setCaptionStyle({ mode: action.mode })
          did(`Legendas ${MODE_LABELS[action.mode]}`, true)
          break
        case 'caption-animation':
          store.setCaptionStyle({ animation: action.animation })
          did(`Legendas ${ANIMATION_LABELS[action.animation]}`, true)
          break
        case 'background': {
          store.setBackground({ presetId: action.presetId })
          const preset = BACKGROUND_PRESETS.find((candidate) => candidate.id === action.presetId)
          did(preset ? `Fundo ${preset.name}` : 'Sem fundo', true)
          break
        }
        case 'export-preset': {
          store.applyExportPreset(action.preset)
          const platform = platformPreset(action.preset)
          did(platform ? `Exportação para ${platform.label}` : 'Exportação com ajustes manuais', true)
          break
        }
        case 'format':
          store.setBackground({ aspect: action.aspect })
          did(`Formato ${FRAME_ASPECT_LABELS[action.aspect]}`, true)
          break
        case 'framing': {
          const ok = store.getState().background.aspect !== 'native'
          if (ok) store.setBackground({ fit: action.fit })
          did(
            `Enquadramento: ${action.fit === 'fill' ? 'preencher' : action.fit === 'follow-mouse' ? 'seguir o mouse' : action.fit === 'follow-zoom' ? 'seguir o zoom' : action.fit === 'follow-object' ? 'seguir o objeto' : 'ajustar'}`,
            ok
          )
          break
        }
        case 'text':
          store.addTextSpan(action, action.text)
          did(`Texto “${action.text.length > 24 ? `${action.text.slice(0, 23)}…` : action.text}” ${span(action)}`, true)
          break
        case 'webcam': {
          const ok = store.session.webcam !== null
          if (ok) store.setWebcam({ visible: action.visible })
          did(action.visible ? 'Câmera mostrada' : 'Câmera oculta', ok)
          break
        }
        case 'volume': {
          if (action.track === 'music') {
            const ok = store.getState().music !== null && store.getState().musicTrack !== null
            if (ok) store.setMusic({ volume: action.volume })
            did(`Música a ${Math.round(action.volume * 100)}%`, ok)
          } else {
            const ok = store.session.audio.some((track) => track.kind === action.track)
            if (ok) store.setTrackVolume(action.track, action.volume)
            did(`${TRACK_LABELS[action.track]} a ${Math.round(action.volume * 100)}%`, ok)
          }
          break
        }
        case 'music-ducking': {
          const ok = store.getState().music !== null && store.getState().musicTrack !== null
          if (ok) store.setMusic({ ducking: action.ducking })
          did(action.ducking === 'off' ? 'Música sem abaixar na fala' : `Música abaixa ${action.ducking === 'light' ? 'um pouco' : 'bastante'} na fala`, ok)
          break
        }
        case 'layout':
          did(`${action.show === 'both' ? 'Tela dividida' : action.show === 'main' ? 'Só o vídeo 1' : 'Só o vídeo 2'} ${span(action)}`, store.applySplitShow(action, action.show))
          break
        case 'second-sound':
          did(
            `Som: ${action.audio === 'main' ? 'só o vídeo 1' : action.audio === 'clip' ? 'só o vídeo 2' : 'os dois'}${action.volume === null ? '' : `, vídeo 2 a ${Math.round(action.volume * 100)}%`}`,
            store.setSecondVideoSound(action.audio, action.volume)
          )
          break
        case 'mute': {
          const ok = store.session.audio.some((track) => track.kind === action.track)
          if (ok) store.setTrackMuted(action.track, action.muted)
          did(`${TRACK_LABELS[action.track]} ${action.muted ? 'mudo' : 'ligado'}`, ok)
          break
        }
      }
    }
  })
  return result
}
