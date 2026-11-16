import type { AssistantEditState } from '@shared/models/assistant'
import type { EditorStore } from './EditorStore'

/** The editor as it stands, in the terms the AI is told about. */
export function editStateOf(store: EditorStore): AssistantEditState {
  const state = store.getState()
  const { session } = store
  return {
    durationMs: session.durationMs,
    cuts: state.trims.map(({ startMs, endMs }) => ({ startMs, endMs })),
    zooms: state.zooms.map(({ startMs, endMs, scale }) => ({ startMs, endMs, scale })),
    speed: state.exportSettings.speed,
    speedRegions: state.speeds.map((region) => ({ startMs: region.startMs, endMs: region.endMs, speed: region.speed })),
    hasCaptions: state.captions.cues.length > 0,
    captionsVisible: state.captions.visible,
    captionLanguage: state.captions.language,
    captionLength: state.captions.length,
    captionMode: state.captions.style.mode,
    backgroundId: state.background.presetId,
    exportPreset: state.exportSettings.preset,
    hasWebcam: session.webcam !== null,
    webcamVisible: state.webcam.visible,
    hasSystemAudio: session.audio.some((track) => track.kind === 'systemAudio'),
    microphoneMuted: state.audio.microphone.muted,
    systemAudioMuted: state.audio.systemAudio.muted,
    microphoneVolume: state.audio.microphone.volume,
    systemAudioVolume: state.audio.systemAudio.volume,
    music: state.music && state.musicTrack ? { volume: state.music.volume, ducking: state.music.ducking } : null
  }
}
