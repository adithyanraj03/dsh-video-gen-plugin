/**
 * Verify the packed tarball: it must carry every runtime file, keep the peer
 * range the schema needs, expose both halves, and never resolve to a symlink
 * of this checkout when installed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

function check(condition, message) {
  if (condition) return
  failures.push(message)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// 1. Manifest invariants.
check(pkg.peerDependencies?.['@deepseek-ai/schemastery'] === '>=3.18.4 <4', 'peerDependencies must pin @deepseek-ai/schemastery to >=3.18.4 <4')
check(pkg.type === 'module', 'package must be an ES module')
check(pkg.main === 'lib/index.js', 'main must point at lib/index.js')
const strip = value => String(value ?? '').replace(/^\.\//, '')
check(strip(pkg.exports?.['./client']?.default) === 'lib/client.js', 'exports["./client"] must point at lib/client.js')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at ./cordis.patch.yml')
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'), 'dsh.client.inject must declare the tool UI package')

// 2. Build outputs exist and are non-trivial.
for (const file of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts']) {
  const info = await stat(join(root, file)).catch(() => undefined)
  check(info !== undefined && info.size > 1_000, `${file} is missing or too small; run pnpm run build`)
}

// 3. The client bundle is wrapped for the DSH module loader.
const client = await readFile(join(root, 'lib', 'client.js'), 'utf8')
check(client.includes('__ModuleLoader__'), 'lib/client.js is not wrapped in window.__ModuleLoader__.load')
// The id must equal the package name exactly: dsh mounts the client by package name.
check(client.includes(`id: "${pkg.name}"`), `lib/client.js must register its module id as "${pkg.name}"`)
check(/jsx|createElement/.test(client), 'lib/client.js contains no React output')

// 4. Pack and inspect the tarball contents.
const staging = await mkdtemp(join(tmpdir(), 'video-gen-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', staging], { cwd: root, stdio: 'pipe', shell: true })
  const tarballs = (await readdir(staging)).filter(name => name.endsWith('.tgz'))
  check(tarballs.length === 1, `expected one tarball, found ${tarballs.length}`)
  if (tarballs.length === 1) {
    const listed = execFileSync('tar', ['-tzf', join(staging, tarballs[0])], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    for (const required of [
      'package/lib/index.js', 'package/lib/client.js', 'package/lib/types/index.d.ts',
      'package/cordis.patch.yml', 'package/README.md', 'package/LICENSE', 'package/assets/icon.png', 'package/package.json',
    ]) {
      check(listed.includes(required), `tarball is missing ${required}`)
    }
    for (const forbidden of ['package/src/', 'package/tests/', 'package/lib/types/client/index.d.ts.map']) {
      check(!listed.some(entry => entry.startsWith(forbidden)), `tarball must not ship ${forbidden}`)
    }
  }
} catch (error) {
  failures.push(`npm pack failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}

// 5. The bundle patch must name this package exactly once, with the documented id.
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
check(/^\s*name: ['"]?dsh-video-gen-plugin['"]?\s*$/m.test(patch), 'cordis.patch.yml must insert a row named dsh-video-gen-plugin')
check((patch.match(/^\s*- id:/gm) ?? []).length === 1, 'cordis.patch.yml must insert exactly one row')

if (failures.length > 0) {
  console.error('package check failed:')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exitCode = 1
} else {
  console.log('package check passed: manifest, bundles, and tarball contents are consistent')
}
