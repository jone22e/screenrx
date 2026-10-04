import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Replaces `filePath` atomically: the content is written to a temporary file
 * in the same directory, flushed to disk and renamed over the target. A
 * crash at any point leaves either the old file or the new one, never a
 * truncated mix.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    const file = await open(tempPath, 'wx')
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
  await syncDirectory(directory)
}

export function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/** Makes the rename itself durable. Not supported on every platform, hence best effort. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory handles cannot be fsynced on Windows; the data is already safe.
  }
}
