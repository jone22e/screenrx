import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MUSIC,
  BACKGROUND_LIMITS,
  CAPTION_LIMITS,
  DEFAULT_BACKGROUND,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_WEBCAM,
  WEBCAM_LIMITS,
  createProject,
  parseProject,
  zoomsOf,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SHAPE_LAYER,
  SHAPE_LIMITS } from './project'

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

  it('reads markers sorted, repairs their labels and gives old projects none', () => {
    const { markers, ...legacy } = createProject(sessionId)
    expect(markers).toEqual([])
    expect(parseProject(legacy, sessionId)?.markers).toEqual([])
    const saved = [
      { id: 'm2', timeMs: 5000, label: '  fim  da   intro ' },
      { id: 'm1', timeMs: 1000, label: 'x'.repeat(200) },
      { id: '', timeMs: 2000, label: 'sem id' },
      { id: 'm3', timeMs: -1, label: 'negativo' },
      { id: 'm4', timeMs: 3000 }
    ]
    expect(parseProject({ ...createProject(sessionId), markers: saved }, sessionId)?.markers).toEqual([
      { id: 'm1', timeMs: 1000, label: 'x'.repeat(80) },
      { id: 'm4', timeMs: 3000, label: '' },
      { id: 'm2', timeMs: 5000, label: 'fim da intro' }
    ])
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
    expect(parsed?.export).toEqual({ format: 'mp4', quality: 'high', compression: 0, fps: 30, speed: 1, loudness: 'off', preset: 'custom' })
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
    expect(parsed?.texts[0]?.enter).toEqual({ kind: 'none', durationMs: 300 })
    const motion = parseProject({ ...createProject(sessionId), texts: [{ id: 'm', startMs: 0, endMs: 1000, text: 'x', enter: { kind: 'pop', durationMs: 9000 }, exit: { kind: 'bounce' } }] }, sessionId)?.texts[0]
    expect(motion?.enter).toEqual({ kind: 'pop', durationMs: 2000 })
    expect(motion?.exit).toEqual({ kind: 'none', durationMs: 300 })
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
  const cue = {
    id: 'cue-1',
    startMs: 0,
    endMs: 1200,
    text: 'Olá, pessoal.',
    words: [
      { text: 'Olá,', startMs: 0, endMs: 500 },
      { text: 'pessoal.', startMs: 500, endMs: 1200 }
    ]
  }

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
        position: { x: 0.3, y: 0.12 },
        mode: 'highlight',
        highlightColor: '#4df0a0',
        animation: 'pop'
      },
      cues: [
        cue,
        {
          id: 'cue-2',
          startMs: 1200,
          endMs: 2500,
          text: 'Hoje vamos exportar.',
          words: [
            { text: 'Hoje', startMs: 1200, endMs: 1500 },
            { text: 'vamos', startMs: 1500, endMs: 1900 },
            { text: 'exportar.', startMs: 1900, endMs: 2500 }
          ]
        }
      ],
      language: 'zh',
      translations: { zh: { 'cue-1': '大家好。', 'cue-2': '今天我们来导出。' }, en: { 'cue-1': 'Hello, everyone.' } }
    }
    expect(parseProject({ ...createProject(sessionId), captions }, sessionId)?.captions).toEqual(captions)
  })

  it('spreads the words of a caption saved without them, or with words that do not fit', () => {
    const parse = (entry: Record<string, unknown>) =>
      parseProject({ ...createProject(sessionId), captions: { cues: [entry] } }, sessionId)?.captions.cues[0]?.words
    const even = [
      { text: 'Olá,', startMs: 0, endMs: 600 },
      { text: 'pessoal.', startMs: 600, endMs: 1200 }
    ]
    const { words, ...bare } = cue
    expect(parse(bare)).toEqual(even)
    // One word for two: not the text's words.
    expect(parse({ ...bare, words: [words[0]] })).toEqual(even)
    // A word past the caption's end.
    expect(parse({ ...bare, words: [words[0], { ...words[1], endMs: 9000 }] })).toEqual(even)
    // Out of order.
    expect(parse({ ...bare, words: [{ ...words[0], startMs: 700 }, { ...words[1], startMs: 500 }] })).toEqual(even)
  })

  it('repairs an unknown mode, highlight colour or animation', () => {
    const style = { mode: 'karaoke', highlightColor: 'yellow', animation: 'bounce' }
    const parsed = parseProject({ ...createProject(sessionId), captions: { style } }, sessionId)?.captions.style
    expect(parsed).toEqual(DEFAULT_CAPTION_STYLE)
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
  it('plays every track at full volume in projects saved before tracks could be muted', () => {
    const { audio, ...legacy } = createProject(sessionId)
    expect(audio).toEqual({ microphone: { muted: false, volume: 1 }, systemAudio: { muted: false, volume: 1 } })
    expect(parseProject(legacy, sessionId)?.audio).toEqual(audio)
  })

  it('keeps which tracks are muted and how loud, and repairs anything else', () => {
    const audio = { microphone: { muted: 'yes', volume: 0.4 }, systemAudio: { muted: true, volume: 3 }, music: { muted: true } }
    expect(parseProject({ ...createProject(sessionId), audio }, sessionId)?.audio).toEqual({
      microphone: { muted: false, volume: 0.4 },
      systemAudio: { muted: true, volume: 1 }
    })
  })

  it('has no music until some is brought in, and repairs saved music settings', () => {
    expect(createProject(sessionId).music).toBeNull()
    expect(parseProject(createProject(sessionId), sessionId)?.music).toBeNull()
    const music = { volume: 2, ducking: 'heavy', loop: 'yes', fadeInMs: -1, fadeOutMs: 500 }
    // A number out of range is clamped; anything else takes the default.
    expect(parseProject({ ...createProject(sessionId), music }, sessionId)?.music).toEqual({
      ...DEFAULT_MUSIC,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 500
    })
    expect(parseProject({ ...createProject(sessionId), music: DEFAULT_MUSIC }, sessionId)?.music).toEqual(DEFAULT_MUSIC)
  })

  it('normalizes loudness for new projects, and leaves old ones as they were mixed', () => {
    expect(createProject(sessionId).export.loudness).toBe('social')
    const { loudness, ...legacy } = createProject(sessionId).export
    expect(loudness).toBe('social')
    expect(parseProject({ ...createProject(sessionId), export: legacy }, sessionId)?.export.loudness).toBe('off')
    expect(parseProject({ ...createProject(sessionId), export: { ...legacy, loudness: 'loud' } }, sessionId)?.export.loudness).toBe('off')
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

describe('parseProject layers', () => {
  const base = createProject(sessionId)
  const placed = { startMs: 0, endMs: 2000, position: { x: 0.5, y: 0.5 }, sizeRatio: 0.2, rotationDeg: 0, opacity: 1, cornerRadiusRatio: 0 }

  it('keeps shapes and emojis as saved, repairing what is out of range', () => {
    const project = parseProject(
      {
        ...base,
        layers: [
          { ...placed, id: 'shape-1', kind: 'shape', shape: 'arrow', aspect: 0.5, fill: false, fillColor: '#00ff00', strokeRatio: 0.01, strokeColor: '#000000' },
          { ...placed, id: 'shape-2', kind: 'shape', shape: 'rectangle', aspect: 99, fillColor: 'red', strokeRatio: -1 },
          { ...placed, id: 'emoji-1', kind: 'emoji', emoji: '  🚀 ' }
        ]
      },
      sessionId
    )
    expect(project?.layers).toEqual([
      { ...placed, id: 'shape-1', kind: 'shape', shape: 'arrow', aspect: 0.5, fill: false, fillColor: '#00ff00', strokeRatio: 0.01, strokeColor: '#000000' },
      { ...placed, id: 'shape-2', kind: 'shape', shape: 'rectangle', aspect: SHAPE_LIMITS.maxAspect, fill: true, fillColor: DEFAULT_SHAPE_LAYER.fillColor, strokeRatio: 0, strokeColor: DEFAULT_SHAPE_LAYER.strokeColor },
      { ...placed, id: 'emoji-1', kind: 'emoji', emoji: '🚀' }
    ])
  })

  it('drops a shape of an unknown kind, an empty emoji and a layer of an unknown kind, keeping the images', () => {
    const project = parseProject(
      {
        ...base,
        layers: [
          { ...placed, id: 'shape-x', kind: 'shape', shape: 'hexagon' },
          { ...placed, id: 'emoji-x', kind: 'emoji', emoji: '   ' },
          { ...placed, id: 'what', kind: 'sticker' },
          { ...placed, id: 'image-1', kind: 'image', file: 'logo.png' }
        ]
      },
      sessionId
    )
    expect(project?.layers.map((layer) => layer.id)).toEqual(['image-1'])
  })
})
