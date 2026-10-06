import { describe, expect, it } from 'vitest'
import { isMeetConfigured, parseMeetSettings } from './meet'

describe('meet settings', () => {
  it('normalizes the address and trims the token', () => {
    expect(parseMeetSettings({ baseUrl: ' https://meet.exemplo.com/// ', token: ' abc ' })).toEqual({
      baseUrl: 'https://meet.exemplo.com',
      token: 'abc'
    })
    expect(parseMeetSettings(null)).toEqual({ baseUrl: '', token: '' })
    expect(parseMeetSettings({ baseUrl: 7, token: null })).toEqual({ baseUrl: '', token: '' })
  })

  it('is configured only with an http(s) address and a token', () => {
    expect(isMeetConfigured({ baseUrl: 'https://meet.exemplo.com', token: 'x' })).toBe(true)
    expect(isMeetConfigured({ baseUrl: 'http://localhost:5180', token: 'x' })).toBe(true)
    expect(isMeetConfigured({ baseUrl: 'meet.exemplo.com', token: 'x' })).toBe(false)
    expect(isMeetConfigured({ baseUrl: 'https://meet.exemplo.com', token: '' })).toBe(false)
  })
})
