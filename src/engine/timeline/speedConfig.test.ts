import { describe, expect, it } from 'vitest'
import type { SpeedEffect } from '@shared/models/project'
import { SPEED_CONFIG, isSpeedFactor, speedAt } from './speedConfig'

const region = (id: string, startMs: number, endMs: number, speed: number): SpeedEffect => ({ id, type: 'speed', startMs, endMs, speed })

describe('speedAt', () => {
  const speeds = [region('a', 1000, 2000, 2), region('b', 5000, 6000, 0.5)]

  it('is the region factor inside a region and 1 outside', () => {
    expect(speedAt(speeds, 0)).toBe(1)
    expect(speedAt(speeds, 1000)).toBe(2)
    expect(speedAt(speeds, 1999)).toBe(2)
    expect(speedAt(speeds, 2000)).toBe(1)
    expect(speedAt(speeds, 5500)).toBe(0.5)
    expect(speedAt([], 100)).toBe(1)
  })
})

describe('isSpeedFactor', () => {
  it('accepts the offered factors only', () => {
    for (const factor of SPEED_CONFIG.factors) expect(isSpeedFactor(factor)).toBe(true)
    expect(isSpeedFactor(1)).toBe(false)
    expect(isSpeedFactor(2.5)).toBe(false)
    expect(isSpeedFactor('2')).toBe(false)
  })
})
