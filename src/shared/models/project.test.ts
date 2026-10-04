import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_LIMITS,
  DEFAULT_BACKGROUND,
  DEFAULT_WEBCAM,
  WEBCAM_LIMITS,
  createProject,
  parseProject,
  zoomsOf
} from './project'

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
    expect(parsed?.export).toEqual({ format: 'mp4', quality: 'high', speed: 1 })
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
      paddingRatio: BACKGROUND_LIMITS.maxPaddingRatio,
      cornerRadiusRatio: 0,
      shadow: false
    })
    expect(parsed?.webcam).toEqual({ ...DEFAULT_WEBCAM, visible: false })
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
