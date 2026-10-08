import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionProgress } from '@shared/models/captions'
import type { Logger } from '../logging/logger'
import type { SessionStore } from '../recording/SessionStore'
import { TranscriptionError, TranscriptionService } from './TranscriptionService'

const SESSION_ID = 'recording-20260101-000000-000'
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

let directory: string

/** A stand-in for the native transcriber: a shell script that prints `lines`, then runs `after`. */
async function fakeTranscriber(lines: string[], after = ''): Promise<string> {
  const file = path.join(directory, `transcriber-${Math.random().toString(36).slice(2)}.sh`)
  const script = ['#!/bin/sh', ...lines.map((line) => `echo '${line}'`), after].join('\n')
  await writeFile(file, script)
  await chmod(file, 0o755)
  return file
}

function createService(binaryPath: string | null, tracks: string[] = ['microphone']) {
  const progress: TranscriptionProgress[] = []
  const sessions = {
    read: () => Promise.resolve({ assets: Object.fromEntries(tracks.map((track) => [track, {}])) }),
    trackPathOf: (_id: string, track: string) => path.join(directory, `${track}.m4a`),
    directoryOf: () => directory,
    setTranscriptPreview: async () => undefined
  } as unknown as SessionStore
  const service = new TranscriptionService({
    binaryPath,
    sessions,
    logger,
    onProgress: (entry) => progress.push(entry)
  })
  return { service, progress }
}

const errorCodeOf = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation
  } catch (error) {
    if (error instanceof TranscriptionError) return error.appError.code
    throw error
  }
  return 'no error'
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'screenrx-transcription-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('TranscriptionService', () => {
  it('collects the words, cleans them and stores the transcript in the session', async () => {
    const binary = await fakeTranscriber([
      '{"type":"status","state":"preparing"}',
      '{"type":"status","state":"transcribing"}',
      '{"type":"words","fraction":0.5,"words":[{"text":"Olá","startMs":0,"endMs":420},{"text":" pessoal,","startMs":420,"endMs":900}]}',
      '{"type":"words","fraction":1,"words":[{"text":" tudo","startMs":900,"endMs":1200},{"text":" bem","startMs":1200,"endMs":1500},{"text":" ?","startMs":1500,"endMs":1550}]}',
      '{"type":"done"}'
    ])
    const { service, progress } = createService(binary)

    const transcript = await service.generate(SESSION_ID, { locale: 'pt-BR', track: 'microphone' })

    expect(transcript.words.map((word) => word.text)).toEqual(['Olá', 'pessoal,', 'tudo', 'bem?'])
    expect(transcript).toMatchObject({ schemaVersion: 1, locale: 'pt-BR', track: 'microphone' })
    expect(JSON.parse(await readFile(path.join(directory, 'transcript.json'), 'utf8'))).toEqual(transcript)
    expect(progress.map((entry) => entry.stage)).toEqual(['preparing', 'transcribing', 'transcribing', 'transcribing'])
    expect(progress.at(-1)?.fraction).toBe(1)
  })

  it('accepts a track with no speech', async () => {
    const { service } = createService(await fakeTranscriber(['{"type":"done"}']))
    const transcript = await service.generate(SESSION_ID, { locale: 'pt-BR', track: 'microphone' })
    expect(transcript.words).toEqual([])
  })

  it('explains an unsupported system or language as unavailable', async () => {
    const binary = await fakeTranscriber(['{"type":"error","code":"unsupported-os","detail":"old"}'], 'exit 1')
    const { service } = createService(binary)
    expect(await errorCodeOf(service.generate(SESSION_ID, { locale: 'pt-BR', track: 'microphone' }))).toBe(
      'transcription-unavailable'
    )
  })

  it('fails when the transcriber stops without finishing', async () => {
    const binary = await fakeTranscriber(['{"type":"status","state":"transcribing"}'], 'exit 3')
    const { service } = createService(binary)
    expect(await errorCodeOf(service.generate(SESSION_ID, { locale: 'pt-BR', track: 'microphone' }))).toBe(
      'transcription-failed'
    )
  })

  it('is unavailable without a transcriber, or when it cannot be started', async () => {
    const request = { locale: 'pt-BR', track: 'microphone' } as const
    expect(await errorCodeOf(createService(null).service.generate(SESSION_ID, request))).toBe(
      'transcription-unavailable'
    )
    const missing = path.join(directory, 'missing-binary')
    expect(await errorCodeOf(createService(missing).service.generate(SESSION_ID, request))).toBe(
      'transcription-unavailable'
    )
  })

  it('refuses a track the session does not have', async () => {
    const { service } = createService(await fakeTranscriber(['{"type":"done"}']))
    expect(await errorCodeOf(service.generate(SESSION_ID, { locale: 'pt-BR', track: 'systemAudio' }))).toBe(
      'transcription-failed'
    )
  })

  it('tells the language from what the helper judged, with every candidate it tried', async () => {
    const binary = await fakeTranscriber([
      '{"type":"status","state":"preparing"}',
      '{"type":"candidate","locale":"pt-BR","installed":true,"confidence":0.31,"count":40}',
      '{"type":"candidate","locale":"en-US","installed":true,"confidence":0.97,"count":44}',
      '{"type":"candidate","locale":"es-ES","installed":false}',
      '{"type":"detected","locale":"en-US"}',
      '{"type":"done"}'
    ])
    const { service } = createService(binary)
    const detection = await service.detectLocale(SESSION_ID, 'microphone', ['pt-BR', 'en-US', 'es-ES'])
    expect(detection.locale).toBe('en-US')
    expect(detection.candidates).toEqual([
      { locale: 'pt-BR', installed: true, confidence: 0.31, words: 40 },
      { locale: 'en-US', installed: true, confidence: 0.97, words: 44 },
      { locale: 'es-ES', installed: false, confidence: 0, words: 0 }
    ])
  })

  it('admits not knowing the language', async () => {
    const binary = await fakeTranscriber(['{"type":"detected","locale":null}', '{"type":"done"}'])
    const { service } = createService(binary)
    expect((await service.detectLocale(SESSION_ID, 'microphone', ['pt-BR'])).locale).toBe(null)
  })

  it('can be cancelled, and runs one transcription at a time', async () => {
    const binary = await fakeTranscriber(['{"type":"status","state":"transcribing"}'], 'exec sleep 30')
    const { service, progress } = createService(binary)
    const request = { locale: 'pt-BR', track: 'microphone' } as const

    const first = errorCodeOf(service.generate(SESSION_ID, request))
    // The stand-in is a shell script: with the whole suite running, it can take more than a second to speak.
    await vi.waitFor(() => expect(progress.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(await errorCodeOf(service.generate(SESSION_ID, request))).toBe('transcription-busy')

    service.cancel()
    expect(await first).toBe('transcription-cancelled')
    // Free again once the cancelled run is gone.
    const { service: next } = createService(await fakeTranscriber(['{"type":"done"}']))
    expect((await next.generate(SESSION_ID, request)).words).toEqual([])
  })
})
