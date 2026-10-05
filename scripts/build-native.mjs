// Builds the native helpers (capture, transcription) for the current platform
// and copies the binaries to dist-native/<platform>/, where the main process
// looks for them in development (packaged builds ship them under
// Resources/native).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELPER_NAMES = ['screenrx-capture', 'screenrx-transcribe']

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[build-native] ${command} ${args.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }
}

function buildMacos() {
  const packageDir = join(projectRoot, 'native', 'macos', 'CaptureHelper')
  const universal = process.argv.includes('--universal')
  const archArgs = universal ? ['--arch', 'arm64', '--arch', 'x86_64'] : []
  run('swift', ['build', '-c', 'release', ...archArgs], packageDir)

  const buildDir = universal
    ? join(packageDir, '.build', 'apple', 'Products', 'Release')
    : join(packageDir, '.build', 'release')
  const outputDir = join(projectRoot, 'dist-native', 'darwin')
  mkdirSync(outputDir, { recursive: true })
  for (const name of HELPER_NAMES) {
    // Replace by rename: a helper that is currently running keeps its own copy
    // instead of having its executable rewritten underneath it.
    const staged = join(outputDir, `${name}.new`)
    copyFileSync(join(buildDir, name), staged)
    renameSync(staged, join(outputDir, name))
    console.log(`[build-native] ${name} -> ${join(outputDir, name)}`)
  }
}

if (process.platform === 'darwin') {
  buildMacos()
} else {
  console.log(`[build-native] no native helpers for ${process.platform} yet; skipping`)
}
