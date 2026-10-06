// Builds the voice helper (dubbing in a cloned voice) and copies it to
// dist-native/<platform>/, next to the other native helpers.
//
// It is a build of its own because it is heavy: the speech runtime takes a
// few minutes to compile the first time. Nothing here is needed to record,
// edit or export; without this helper the app simply offers no dubbing.
//
// Three things happen:
//   1. the speech runtime (mlx-audio-swift) is fetched at a pinned revision
//      into Vendor/ and the project's patches are applied to it;
//   2. the helper is compiled;
//   3. MLX's compiled shader library is put next to it — built with Xcode's
//      Metal toolchain when it is installed, otherwise taken from Apple's own
//      MLX release of the same version.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = join(projectRoot, 'native', 'macos', 'VoiceHelper')
const vendorDir = join(packageDir, 'Vendor', 'mlx-audio-swift')
const outputDir = join(projectRoot, 'dist-native', 'darwin')

const RUNTIME_REPOSITORY = 'https://github.com/Blaizzy/mlx-audio-swift.git'
/** The revision the helper and the patches were written against. */
const RUNTIME_REVISION = '8d86630ade569728aaea3dc1a29fc44e2efa719b'
const HELPER_NAME = 'screenrx-dub'
const SHADER_LIBRARY = 'mlx.metallib'

function run(command, args, cwd, { quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function must(command, args, cwd) {
  if (!run(command, args, cwd).ok) {
    console.error(`[build-voice] ${command} ${args.join(' ')} failed`)
    process.exit(1)
  }
}

/** Fetches the runtime at the pinned revision and applies the project's patches, once. */
function prepareRuntime() {
  const stamp = join(vendorDir, '.screenrx-revision')
  const patches = readdirSync(join(packageDir, 'patches')).filter((name) => name.endsWith('.patch')).sort()
  const wanted = `${RUNTIME_REVISION}\n${patches.map((name) => `${name}:${readFileSync(join(packageDir, 'patches', name), 'utf8').length}`).join('\n')}\n`
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted) return

  console.log('[build-voice] fetching the speech runtime…')
  rmSync(vendorDir, { recursive: true, force: true })
  mkdirSync(vendorDir, { recursive: true })
  must('git', ['init', '--quiet'], vendorDir)
  must('git', ['remote', 'add', 'origin', RUNTIME_REPOSITORY], vendorDir)
  must('git', ['fetch', '--quiet', '--depth', '1', 'origin', RUNTIME_REVISION], vendorDir)
  must('git', ['checkout', '--quiet', 'FETCH_HEAD'], vendorDir)
  for (const patch of patches) {
    must('git', ['apply', join(packageDir, 'patches', patch)], vendorDir)
    console.log(`[build-voice] applied ${patch}`)
  }
  writeFileSync(stamp, wanted)
}

/** The version of MLX the helper was compiled against, e.g. `0.31.1`. */
function mlxVersion() {
  const header = readFileSync(
    join(packageDir, '.build', 'checkouts', 'mlx-swift', 'Source', 'Cmlx', 'mlx', 'mlx', 'version.h'),
    'utf8'
  )
  const part = (name) => /(\d+)/.exec(header.split(`MLX_VERSION_${name}`)[1] ?? '')?.[1]
  const version = [part('MAJOR'), part('MINOR'), part('PATCH')]
  if (version.some((value) => value === undefined)) throw new Error('could not read the MLX version')
  return version.join('.')
}

/** Compiles the shaders with Xcode's Metal toolchain. Returns whether it could. */
function compileShaders(target) {
  const sources = join(packageDir, '.build', 'checkouts', 'mlx-swift', 'Source', 'Cmlx', 'mlx-generated', 'metal')
  const workDir = join(packageDir, '.build', 'shader-objects')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const objects = []
  for (const name of readdirSync(sources).filter((file) => file.endsWith('.metal'))) {
    const object = join(workDir, name.replace(/\.metal$/, '.air'))
    if (!run('xcrun', ['-sdk', 'macosx', 'metal', '-c', join(sources, name), '-I', sources, '-o', object], packageDir, { quiet: true }).ok) {
      return false
    }
    objects.push(object)
  }
  return run('xcrun', ['-sdk', 'macosx', 'metallib', ...objects, '-o', target], packageDir, { quiet: true }).ok
}

/** Takes the shader library from Apple's MLX release of the same version (a wheel on PyPI). */
async function downloadShaders(version, target) {
  const response = await fetch(`https://pypi.org/pypi/mlx-metal/${version}/json`)
  if (!response.ok) throw new Error(`no mlx-metal ${version} on PyPI (${response.status})`)
  const release = await response.json()
  const wheel = release.urls.find((file) => file.filename.endsWith('macosx_14_0_arm64.whl'))
  if (!wheel) throw new Error(`mlx-metal ${version} has no macOS arm64 wheel`)

  console.log(`[build-voice] downloading ${wheel.filename} (${Math.round(wheel.size / 1e6)} MB) for the shader library…`)
  const archive = `${target}.whl`
  const download = await fetch(wheel.url)
  if (!download.ok) throw new Error(`download failed (${download.status})`)
  writeFileSync(archive, Buffer.from(await download.arrayBuffer()))
  const unpacked = run('unzip', ['-o', '-j', '-q', archive, `mlx/lib/${SHADER_LIBRARY}`, '-d', dirname(target)], packageDir, { quiet: true })
  rmSync(archive, { force: true })
  if (!unpacked.ok || !existsSync(target)) throw new Error(`could not unpack the shader library: ${unpacked.output}`)
}

async function shaderLibrary() {
  const version = mlxVersion()
  const target = join(packageDir, '.build', 'mlx-shaders', version, SHADER_LIBRARY)
  if (existsSync(target)) return target
  mkdirSync(dirname(target), { recursive: true })
  if (compileShaders(target)) {
    console.log('[build-voice] shader library compiled with the Metal toolchain')
  } else {
    // Xcode ships the Metal toolchain as a separate download; this avoids requiring it.
    await downloadShaders(version, target)
  }
  return target
}

/** Replace by rename: a helper that is running keeps its own copy. */
function install(source, name) {
  mkdirSync(outputDir, { recursive: true })
  const staged = join(outputDir, `${name}.new`)
  copyFileSync(source, staged)
  renameSync(staged, join(outputDir, name))
  console.log(`[build-voice] ${name} -> ${join(outputDir, name)}`)
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log('[build-voice] the voice helper needs a Mac with Apple Silicon; skipping')
  process.exit(0)
}

prepareRuntime()
must('swift', ['build', '-c', 'release'], packageDir)
install(join(packageDir, '.build', 'release', HELPER_NAME), HELPER_NAME)
install(await shaderLibrary(), SHADER_LIBRARY)
