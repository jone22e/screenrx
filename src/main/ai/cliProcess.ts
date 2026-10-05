import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

/** Where command-line tools are usually installed, beyond the `PATH` the app was started with. */
export function defaultAiSearchDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const fromPath = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  const common = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin')
  ]
  return [...new Set([...fromPath, ...common])]
}

/** The first executable called `name` in `searchDirs`, or `null`. */
export async function locateBinary(searchDirs: readonly string[], name: string): Promise<string | null> {
  for (const directory of searchDirs) {
    const candidate = path.join(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}

/**
 * The environment a tool is started with. The tools run as fresh, standalone
 * commands: variables of a Claude Code session the app may have been started
 * from are not passed on, so a CLI does not mistake itself for a nested
 * session. The search directories go on `PATH`, because a tool installed
 * with a package manager needs to find its own runtime.
 */
export function toolEnv(
  env: NodeJS.ProcessEnv,
  searchDirs: readonly string[],
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('CLAUDE')) result[key] = value
  }
  const inherited = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  result['PATH'] = [...new Set([...searchDirs, ...inherited, '/usr/bin', '/bin'])].join(path.delimiter)
  return { ...result, ...extra }
}

export interface ToolRun {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to the tool's stdin, which is then closed. */
  input?: string
  timeoutMs: number
  /** Aborting terminates the tool. */
  signal?: AbortSignal
}

export interface ToolResult {
  /** Exit code; `null` when the tool was terminated. */
  code: number | null
  stdout: string
  /** The end of what the tool wrote to stderr. */
  stderr: string
  timedOut: boolean
  aborted: boolean
}

const MAX_OUTPUT_CHARS = 8 * 1024 * 1024
const STDERR_TAIL_CHARS = 4000

/** Runs a command-line tool to completion, without a shell. Rejects only when it cannot be started. */
export function runTool(binary: string, args: readonly string[], run: ToolRun): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { cwd: run.cwd, env: run.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, run.timeoutMs)
    const abort = (): void => {
      aborted = true
      child.kill('SIGTERM')
    }
    if (run.signal?.aborted) abort()
    run.signal?.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    // A tool that exits early closes its stdin; that failure shows in its exit code.
    child.stdin.on('error', () => undefined)
    child.stdin.end(run.input ?? '')

    const finish = (): void => {
      clearTimeout(timer)
      run.signal?.removeEventListener('abort', abort)
    }
    child.once('error', (error) => {
      finish()
      reject(error)
    })
    child.once('close', (code) => {
      finish()
      resolve({ code, stdout, stderr, timedOut, aborted })
    })
  })
}

/** The last non-empty line a tool printed: usually its error message. */
export function lastLine(result: ToolResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim())
  return lines.filter(Boolean).pop() ?? ''
}
