import { spawn } from 'node:child_process'
import type { TranscriptWord } from '@shared/models/captions'
import { parseTranscriptWord } from '@shared/models/captions'
import { JsonLineDecoder } from '../capture/macos/JsonLineDecoder'

/**
 * Runs the native transcriber on one audio file and returns the words it
 * hears. Unlike `TranscriptionService` this stores nothing and reports no
 * progress: it is for listening to short clips (e.g. checking synthesized
 * speech), several at a time.
 */
export function transcribeFile(
  binaryPath: string,
  audioPath: string,
  locale: string,
  signal?: AbortSignal
): Promise<TranscriptWord[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['--input', audioPath, '--locale', locale], { stdio: ['ignore', 'pipe', 'ignore'] })
    const words: TranscriptWord[] = []
    let finished = false
    let failure: string | null = null

    const decoder = new JsonLineDecoder(
      (message) => {
        if (typeof message !== 'object' || message === null) return
        const { type, code } = message as Record<string, unknown>
        if (type === 'words') {
          const batch = (message as { words?: unknown }).words
          for (const entry of Array.isArray(batch) ? batch : []) {
            const word = parseTranscriptWord(entry)
            if (word) words.push(word)
          }
        } else if (type === 'done') {
          finished = true
        } else if (type === 'error') {
          failure = typeof code === 'string' ? code : 'failed'
        }
      },
      () => undefined
    )
    child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))

    const abort = (): void => void child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (exitCode) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('transcription aborted'))
      else if (failure) reject(new Error(`transcriber: ${failure}`))
      else if (exitCode === 0 && finished) resolve(words)
      else reject(new Error(`transcriber exited with ${exitCode ?? 'a signal'}`))
    })
  })
}
