import { StringDecoder } from 'node:string_decoder'

/** Source listings with thumbnails are the largest messages; this is far above them. */
const MAX_LINE_LENGTH = 64 * 1024 * 1024

/**
 * Reassembles newline-delimited JSON from arbitrary stream chunks. Lines can
 * be split anywhere, including inside a multi-byte character.
 */
export class JsonLineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onInvalid: (reason: string) => void
  ) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.parse(line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE_LENGTH) {
      this.buffer = ''
      this.onInvalid('line exceeds the maximum length')
    }
  }

  private parse(line: string): void {
    if (line.trim() === '') return
    try {
      this.onMessage(JSON.parse(line))
    } catch {
      this.onInvalid(`not JSON: ${line.slice(0, 200)}`)
    }
  }
}
