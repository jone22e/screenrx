import { describe, expect, it } from 'vitest'
import type { AssistantRequest } from '@shared/models/assistant'
import type { TranscriptWord } from '@shared/models/captions'
import { ASSISTANT_RESPONSE_SCHEMA, buildAssistantPrompt, parseAssistantResponse } from './assistantPrompt'

const words: TranscriptWord[] = [
  { text: 'oi', startMs: 1000, endMs: 1300 },
  { text: 'hoje', startMs: 1400, endMs: 1700 },
  { text: 'vamos', startMs: 1800, endMs: 2100 },
  { text: 'ver', startMs: 2200, endMs: 2500 },
  { text: 'o', startMs: 6000, endMs: 6100 },
  { text: 'pedido', startMs: 6200, endMs: 6700 },
  { text: 'tchau', startMs: 12_000, endMs: 12_400 }
]
const DURATION_MS = 20_000

const request: AssistantRequest = {
  message: 'corta o começo',
  history: [{ role: 'user', text: 'oi' }, { role: 'assistant', text: 'Olá!' }],
  edit: {
    durationMs: DURATION_MS,
    cuts: [{ startMs: 3000, endMs: 4000 }],
    zooms: [{ startMs: 6000, endMs: 9000, scale: 1.6 }],
    speed: 1,
    hasCaptions: true,
    captionsVisible: true,
    captionLanguage: null,
    captionLength: 'medium',
    backgroundId: 'aurora',
    hasWebcam: false,
    webcamVisible: true,
    hasSystemAudio: true,
    microphoneMuted: false,
    systemAudioMuted: true
  }
}

describe('buildAssistantPrompt', () => {
  it('describes the edit, the transcript with time markers and pauses, and the conversation', () => {
    const { prompt, wordCount } = buildAssistantPrompt(request, words, 'pt-BR')
    expect(wordCount).toBe(words.length)
    expect(prompt).toContain('Cuts (1):\n  0:03.0–0:04.0')
    expect(prompt).toContain('Zooms (1):\n  0:06.0–0:09.0 1.6x')
    expect(prompt).toContain('System audio: off')
    expect(prompt).toContain('Webcam: not recorded')
    expect(prompt).toContain('-- 0:01.0 --\n0 oi')
    expect(prompt).toContain('3 ver\n-- pause 3.8s --\n4 o')
    expect(prompt).toContain('-- 0:12.0 --\n6 tchau')
    expect(prompt).toContain('User: oi\nAssistant: Olá!\n\nUser: corta o começo')
    expect(prompt.endsWith('User: corta o começo')).toBe(true)
  })

  it('says when there is no transcript', () => {
    const { prompt } = buildAssistantPrompt({ ...request, history: [] }, [], null)
    expect(prompt).toContain('Transcript: none')
    expect(prompt).not.toContain('Conversation so far')
  })

  it('offers a strict schema: every action field is required', () => {
    const item = ASSISTANT_RESPONSE_SCHEMA.properties.actions.items
    expect(item.required).toEqual(Object.keys(item.properties))
  })
})

describe('parseAssistantResponse', () => {
  const action = (fields: Record<string, unknown>) => ({
    fromWord: null,
    toWord: null,
    startSec: null,
    endSec: null,
    scale: null,
    value: null,
    ...fields
  })
  const parse = (actions: unknown[], reply = 'Feito.') => parseAssistantResponse({ reply, actions }, words, DURATION_MS)

  it('maps a cut given in words to the start of the word after it', () => {
    expect(parse([action({ type: 'cut', fromWord: 0, toWord: 1 })]).actions).toEqual([
      { type: 'cut', startMs: 1000, endMs: 1800 }
    ])
  })

  it('takes a stretch in seconds, clamped to the recording', () => {
    expect(parse([action({ type: 'cut', startSec: 15, endSec: 40 })]).actions).toEqual([
      { type: 'cut', startMs: 15_000, endMs: 20_000 }
    ])
  })

  it('gives a zoom without an end its default length, and keeps the scale within limits', () => {
    expect(parse([action({ type: 'zoom', fromWord: 4, scale: 9 })]).actions).toEqual([
      { type: 'zoom', startMs: 6000, endMs: 9000, scale: 4 }
    ])
    expect(parse([action({ type: 'zoom', startSec: 2 })]).actions).toEqual([
      { type: 'zoom', startMs: 2000, endMs: 5000, scale: null }
    ])
  })

  it('reads the settings from their values', () => {
    const { actions } = parse([
      action({ type: 'speed', value: '1,5x' }),
      action({ type: 'captions', value: 'hide' }),
      action({ type: 'caption-language', value: 'EN' }),
      action({ type: 'caption-language', value: 'original' }),
      action({ type: 'caption-length', value: 'short' }),
      action({ type: 'background', value: 'ocean' }),
      action({ type: 'background', value: 'none' }),
      action({ type: 'webcam', value: 'show' }),
      action({ type: 'mute', value: 'system' }),
      action({ type: 'unmute', value: 'microphone' }),
      action({ type: 'uncut', startSec: 2, endSec: 5 }),
      action({ type: 'remove-zoom', fromWord: 4, toWord: 5 })
    ])
    expect(actions).toEqual([
      { type: 'speed', speed: 1.5 },
      { type: 'captions', visible: false },
      { type: 'caption-language', language: 'en' },
      { type: 'caption-language', language: null },
      { type: 'caption-length', length: 'short' },
      { type: 'background', presetId: 'ocean' },
      { type: 'background', presetId: null },
      { type: 'webcam', visible: true },
      { type: 'mute', track: 'systemAudio', muted: true },
      { type: 'mute', track: 'microphone', muted: false },
      { type: 'uncut', startMs: 2000, endMs: 5000 },
      { type: 'remove-zoom', startMs: 6000, endMs: 12_000 }
    ])
  })

  it('drops what the editor cannot do', () => {
    const { actions, text } = parse(
      [
        action({ type: 'speed', value: '1.7' }),
        action({ type: 'background', value: 'neon' }),
        action({ type: 'cut', fromWord: 5, toWord: 2 }),
        action({ type: 'cut', fromWord: 99 }),
        action({ type: 'cut' }),
        action({ type: 'mute', value: 'camera' }),
        action({ type: 'explode' }),
        'nonsense'
      ],
      'Tentei.'
    )
    expect(actions).toEqual([])
    expect(text).toBe('Tentei.')
  })

  it('survives an answer that is not the expected shape', () => {
    expect(parseAssistantResponse(null, words, DURATION_MS)).toEqual({ text: '', actions: [] })
    expect(parseAssistantResponse({ reply: 42, actions: 'x' }, words, DURATION_MS)).toEqual({ text: '', actions: [] })
  })
})
