import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_LIMITS,
  CAPTION_LIMITS,
  DEFAULT_BACKGROUND,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_WEBCAM,
  WEBCAM_LIMITS,
  createProject,
  parseProject,
  zoomsOf,
  DEFAULT_EXPORT_SETTINGS } from './project'

const sessionId = 'recording-20261003-201530-123'
const zoom = {
  id: 'zoom-1',
  type: 'zoom',
  startMs: 5000,
  endMs: 8200,
  focus: { x: 0.72, y: 0.41 },
  scale: 1.7,
  easing: 'easeInOut',
  mode: 'auto'
}

describe('parseProject', () => {
  it('round-trips a valid project', () => {
    const project = createProject(sessionId, [zoom as never])
    expect(parseProject(JSON.parse(JSON.stringify(project)), sessionId)).toEqual(project)
  })

  it('drops unknown fields instead of persisting them', () => {
    const parsed = parseProject(
      { ...createProject(sessionId, [{ ...zoom, hover: true } as never]), modalOpen: true },
      sessionId
    )
    expect(parsed).not.toHaveProperty('modalOpen')
    expect(parsed?.effects[0]).not.toHaveProperty('hover')
  })

  it.each([
    ['another session', { ...createProject('recording-20200101-000000-000') }],
    ['an unknown schema version', { ...createProject(sessionId), schemaVersion: 99 }],
    ['an inverted span', createProject(sessionId, [{ ...zoom, endMs: 100 } as never])],
    ['a non-numeric time', createProject(sessionId, [{ ...zoom, startMs: 'soon' } as never])],
    ['a scale below 1', createProject(sessionId, [{ ...zoom, scale: 0.2 } as never])],
    ['an unknown effect type', createProject(sessionId, [{ ...zoom, type: 'explode' } as never])],
    ['a missing focus', createProject(sessionId, [{ ...zoom, focus: null } as never])],
    ['a non-object', 'project']
  ])('rejects %s', (_name, value) => {
    expect(parseProject(value, sessionId)).toBeNull()
  })

  it('repairs export settings rather than rejecting the project', () => {
    const parsed = parseProject({ ...createProject(sessionId), export: { speed: -3 } }, sessionId)
    expect(parsed?.export).toEqual({ format: 'mp4', quality: 'high', compression: 0, fps: 30, speed: 1 })
    const level = (compression: unknown) =>
      parseProject({ ...createProject(sessionId), export: { ...DEFAULT_EXPORT_SETTINGS, compression } }, sessionId)?.export.compression
    expect(level(3)).toBe(3)
    expect(level('compact')).toBe(2)
    expect(level(9)).toBe(0)
  })

  it('keeps a supported export frame rate and repairs any other', () => {
    const withFps = (fps: unknown) => parseProject({ ...createProject(sessionId), export: { fps } }, sessionId)?.export.fps
    expect(withFps(24)).toBe(24)
    expect(withFps(60)).toBe(60)
    expect(withFps(25)).toBe(30)
    expect(withFps('60')).toBe(30)
    expect(withFps(undefined)).toBe(30)
  })
})

describe('parseProject framing', () => {
  it('gives projects saved before framing existed the default look', () => {
    const { background, webcam, ...legacy } = createProject(sessionId)
    expect(background).toEqual(DEFAULT_BACKGROUND)
    expect(webcam).toEqual(DEFAULT_WEBCAM)
    expect(parseProject(legacy, sessionId)).toEqual(createProject(sessionId))
    // A project that only knew whether the webcam was visible keeps that choice.
    expect(parseProject({ ...legacy, webcam: { visible: false } }, sessionId)?.webcam).toEqual({
      ...DEFAULT_WEBCAM,
      visible: false
    })
  })

  it('keeps valid settings and clamps out-of-range ones', () => {
    const parsed = parseProject(
      {
        ...createProject(sessionId),
        background: { presetId: null, paddingRatio: 9, cornerRadiusRatio: -1, shadow: false },
        webcam: { visible: false }
      },
      sessionId
    )
    expect(parsed?.background).toEqual({
      presetId: null,
      aspect: 'native',
      fit: 'fit',
      crop: { x: 0.5, y: 0.5 },
      scale: 1,
      align: 'center',
      paddingRatio: BACKGROUND_LIMITS.maxPaddingRatio,
      cornerRadiusRatio: 0,
      shadow: false
    })
    expect(parsed?.webcam).toEqual({ ...DEFAULT_WEBCAM, visible: false })
    expect(
      parseProject({ ...createProject(sessionId), background: { presetId: null, aspect: 'reels' } }, sessionId)?.background.aspect
    ).toBe('9:16')
    expect(
      parseProject({ ...createProject(sessionId), background: { presetId: null, aspect: '4:5', fit: 'follow', scale: 1.5, align: 'top' } }, sessionId)?.background
    ).toMatchObject({ aspect: '4:5', fit: 'follow-zoom', scale: 1.5, align: 'top' })
    expect(
      parseProject({ ...createProject(sessionId), background: { presetId: null, aspect: '9:16', fit: 'follow-mouse' } }, sessionId)?.background.fit
    ).toBe('follow-mouse')
    const filled = parseProject(
      { ...createProject(sessionId), background: { presetId: null, aspect: 'tiktok', fit: 'fill', crop: { x: 1.4, y: 0.2 } } },
      sessionId
    )?.background
    expect(filled).toMatchObject({ aspect: '9:16', fit: 'fill', crop: { x: 1, y: 0.2 } })
    expect(
      parseProject({ ...createProject(sessionId), background: { presetId: null, aspect: '3:7' } }, sessionId)?.background.aspect
    ).toBe('native')
  })

  it('reads the texts over the video, sorted, and gives old projects none', () => {
    expect(parseProject(createProject(sessionId), sessionId)?.texts).toEqual([])
    const parsed = parseProject(
      {
        ...createProject(sessionId),
        texts: [
          { id: 'b', startMs: 5000, endMs: 8000, text: 'Depois', style: { sizeRatio: 9, color: 'red' } },
          { id: 'a', startMs: 1000, endMs: 3000, text: 'Antes' },
          { id: 'x', startMs: 3000, endMs: 1000, text: 'Inválido' },
          { id: 'y', startMs: 0, endMs: 1000 }
        ]
      },
      sessionId
    )
    expect(parsed?.texts.map((text) => text.id)).toEqual(['a', 'b'])
    expect(parsed?.texts[1]?.style).toMatchObject({ sizeRatio: 0.1, color: '#ffffff' })
  })

  it('accepts a freely placed square webcam and repairs nonsense', () => {
    const webcam = { visible: true, shape: 'square', sizeRatio: 0.3, corner: null, position: { x: 0.2, y: 0.7 }, border: false, mirrored: true }
    expect(parseProject({ ...createProject(sessionId), webcam }, sessionId)?.webcam).toEqual(webcam)

    const repaired = parseProject(
      { ...createProject(sessionId), webcam: { shape: 'hexagon', sizeRatio: 40, corner: 'middle', position: { x: 7 } } },
      sessionId
    )?.webcam
    expect(repaired).toEqual({
      ...DEFAULT_WEBCAM,
      sizeRatio: WEBCAM_LIMITS.maxSizeRatio,
      position: { x: 1, y: DEFAULT_WEBCAM.position.y }
    })
  })
})

describe('parseProject captions', () => {
  const cue = { id: 'cue-1', startMs: 0, endMs: 1200, text: 'Olá, pessoal.' }

  it('gives projects saved before captions existed none, with the default style', () => {
    const { captions, ...legacy } = createProject(sessionId)
    expect(captions).toEqual({
      visible: true,
      length: 'medium',
      style: DEFAULT_CAPTION_STYLE,
      cues: [],
      language: null,
      translations: {}
    })
    expect(parseProject(legacy, sessionId)?.captions).toEqual(captions)
  })

  it('round-trips captions with their style', () => {
    const captions = {
      visible: false,
      length: 'short',
      style: {
        font: 'impact',
        sizeRatio: 0.06,
        bold: false,
        uppercase: true,
        color: '#ffe14d',
        backdrop: 'outline',
        backdropColor: '#101010',
        position: { x: 0.3, y: 0.12 }
      },
      cues: [cue, { id: 'cue-2', startMs: 1200, endMs: 2500, text: 'Hoje vamos exportar.' }],
      language: 'zh',
      translations: { zh: { 'cue-1': '大家好。', 'cue-2': '今天我们来导出。' }, en: { 'cue-1': 'Hello, everyone.' } }
    }
    expect(parseProject({ ...createProject(sessionId), captions }, sessionId)?.captions).toEqual(captions)
  })

  it('repairs a nonsense style instead of rejecting the project', () => {
    const style = { font: 'comic', sizeRatio: 3, bold: 'yes', color: 'red', backdrop: 'glow', backdropColor: '#12', position: { x: -4 } }
    expect(parseProject({ ...createProject(sessionId), captions: { length: 'huge', style } }, sessionId)?.captions).toEqual({
      visible: true,
      length: 'medium',
      style: {
        ...DEFAULT_CAPTION_STYLE,
        sizeRatio: CAPTION_LIMITS.maxSizeRatio,
        position: { x: 0, y: DEFAULT_CAPTION_STYLE.position.y }
      },
      cues: [],
      language: null,
      translations: {}
    })
  })

  it('keeps translations only of captions that exist, and never shows a language without one', () => {
    const captions = {
      cues: [cue],
      language: 'es',
      translations: {
        en: { 'cue-1': 'Hello, everyone.', 'cue-gone': 'left over', 'cue-2': 7 },
        es: { 'cue-gone': 'sobra' },
        fr: { 'cue-1': 'Bonjour' },
        zh: 'not a map'
      }
    }
    const parsed = parseProject({ ...createProject(sessionId), captions }, sessionId)?.captions
    expect(parsed?.translations).toEqual({ en: { 'cue-1': 'Hello, everyone.' } })
    // Spanish had no caption left, so the captions are shown as spoken.
    expect(parsed?.language).toBeNull()
  })

  it('drops malformed and overlapping captions, keeping the rest', () => {
    const cues = [
      cue,
      { id: 'overlaps', startMs: 800, endMs: 1500, text: 'sobreposta' },
      { id: 'inverted', startMs: 3000, endMs: 2000, text: 'invertida' },
      { id: 'no-text', startMs: 3000, endMs: 3500 },
      'not a cue',
      { id: 'cue-2', startMs: 4000, endMs: 5000, text: 'x'.repeat(1000), extra: true }
    ]
    const parsed = parseProject({ ...createProject(sessionId), captions: { cues } }, sessionId)?.captions.cues
    expect(parsed?.map((entry) => entry.id)).toEqual(['cue-1', 'cue-2'])
    expect(parsed?.[1]?.text).toHaveLength(CAPTION_LIMITS.maxTextLength)
    expect(parsed?.[1]).not.toHaveProperty('extra')
  })
})

describe('parseProject audio', () => {
  it('plays every track in projects saved before tracks could be muted', () => {
    const { audio, ...legacy } = createProject(sessionId)
    expect(audio).toEqual({ microphone: { muted: false }, systemAudio: { muted: false } })
    expect(parseProject(legacy, sessionId)?.audio).toEqual(audio)
  })

  it('keeps which tracks are muted and repairs anything else', () => {
    const audio = { microphone: { muted: 'yes' }, systemAudio: { muted: true, volume: 3 }, music: { muted: true } }
    expect(parseProject({ ...createProject(sessionId), audio }, sessionId)?.audio).toEqual({
      microphone: { muted: false },
      systemAudio: { muted: true }
    })
  })
})

describe('zoomsOf', () => {
  it('returns only zooms, sorted by start time', () => {
    const project = createProject(sessionId, [
      { ...zoom, id: 'late', startMs: 9000, endMs: 9900 } as never,
      { id: 'cut', type: 'trim', startMs: 0, endMs: 100 },
      { ...zoom, id: 'early', startMs: 1000, endMs: 2000 } as never
    ])
    expect(zoomsOf(project).map((effect) => effect.id)).toEqual(['early', 'late'])
  })
})
