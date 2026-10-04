// Builds the native capture helper for the current platform and copies the
// binary to dist-native/<platform>/, where the main process looks for it in
// development (packaged builds ship it under Resources/native).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELPER_NAME = 'screenrx-capture'

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

  const builtBinary = universal
    ? join(packageDir, '.build', 'apple', 'Products', 'Release', HELPER_NAME)
    : join(packageDir, '.build', 'release', HELPER_NAME)
  const outputDir = join(projectRoot, 'dist-native', 'darwin')
  mkdirSync(outputDir, { recursive: true })
  // Replace by rename: a helper that is currently running keeps its own copy
  // instead of having its executable rewritten underneath it.
  const staged = join(outputDir, `${HELPER_NAME}.new`)
  copyFileSync(builtBinary, staged)
  renameSync(staged, join(outputDir, HELPER_NAME))
  console.log(`[build-native] ${HELPER_NAME} -> ${join(outputDir, HELPER_NAME)}`)
}

if (process.platform === 'darwin') {
  buildMacos()
} else {
  console.log(`[build-native] no native capture helper for ${process.platform} yet; skipping`)
}
