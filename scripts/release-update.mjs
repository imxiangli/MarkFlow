/**
 * Publishes an update into a static folder that can be uploaded to any web host / CDN,
 * or (with --github) into a flat folder of GitHub release assets.
 *
 *   npm run build && node scripts/release-update.mjs [options]
 *
 * Options:
 *   --out <dir>        output folder (default: release/update, or release/github/<version>).
 *                      For a web host, re-use it between releases: files are stored by content
 *                      hash, so unchanged files are kept once.
 *   --src <dir>        folder containing out/ and resources/ (default: project root)
 *   --version <x.y.z>  version to publish (default: package.json version)
 *   --notes <text>     release notes (or --notes-file <path>)
 *   --full-dir <dir>   where electron-builder put installers (default: release/<version>)
 *   --no-full          do not attach full installers
 *   --electron <ver>   override the Electron version recorded in the manifest (testing)
 *   --skip-key-check   allow a key that does not match src/main/update-public-key.ts (testing)
 *
 * GitHub Releases (see .github/workflows/build.yml):
 *   --github <owner/repo>  write latest.json, latest.json.sig and the new <sha256>.gz blobs into
 *                          --out, to be uploaded as assets of the release tagged --tag. Every
 *                          URL in the manifest is absolute; installers are expected to be
 *                          uploaded to the same release under their own names.
 *   --tag <tag>            release tag (default: v<version>)
 *   --previous <file>      latest.json of the previous release: blobs it already has are
 *                          referenced from there instead of being uploaded again
 *
 * Signing key: $MARKFLOW_UPDATE_KEY (PEM text) or keys/update-private.pem
 * (create one with `node scripts/update-keygen.mjs`).
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = opt('version', pkg.version)
const src = resolve(opt('src', root))
const github = opt('github', '')
if (github && !/^[\w.-]+\/[\w.-]+$/.test(github)) {
  console.error(`--github expects owner/repo, got "${github}"`)
  process.exit(1)
}
const outDir = resolve(opt('out', join(root, github ? `release/github/${version}` : 'release/update')))
const fullDir = resolve(opt('full-dir', join(root, 'release', version)))
const notes = opt('notes-file') ? readFileSync(opt('notes-file'), 'utf8') : opt('notes', undefined)
const tag = opt('tag', `v${version}`)
const assetUrl = (name) => `https://github.com/${github}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
const electron = opt('electron', JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version)
const bootstrapApi = Number(/BOOTSTRAP_API = (\d+)/.exec(readFileSync(join(root, 'src/bootstrap/index.ts'), 'utf8'))[1])

const keyPem = process.env.MARKFLOW_UPDATE_KEY || (existsSync(join(root, 'keys/update-private.pem')) ? readFileSync(join(root, 'keys/update-private.pem'), 'utf8') : null)
if (!keyPem) {
  console.error('No signing key: set MARKFLOW_UPDATE_KEY or run `node scripts/update-keygen.mjs`.')
  process.exit(1)
}
if (!existsSync(join(src, 'out/main/index.js'))) {
  console.error(`${src}/out is missing — run \`npm run build\` first.`)
  process.exit(1)
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    if (!e.isFile() || e.name.endsWith('.map') || e.name === '.DS_Store') return []
    return [p]
  })
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function sha512File(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha512')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
}

// GitHub assets are flat; a web host keeps blobs under files/.
const filesDir = github ? outDir : join(outDir, 'files')
mkdirSync(filesDir, { recursive: true })

// Previous manifest, to report how much an existing install has to download
// (and, for GitHub, to reuse blobs uploaded with earlier releases).
let previous = null
try {
  const previousPath = opt('previous', github ? null : join(outDir, 'latest.json'))
  previous = previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')) : null
  if (!Array.isArray(previous?.files)) previous = null
} catch {
  previous = null
}
const ownAssets = `https://github.com/${github}/releases/download/${encodeURIComponent(tag)}/`
const previousBlobs = new Map(
  github && previous
    ? previous.files
        .filter((f) => typeof f.url === 'string' && f.url.startsWith(`https://github.com/${github}/releases/download/`) && !f.url.startsWith(ownAssets))
        .map((f) => [f.sha256, f])
    : []
)

// 1. App files → content-addressed gzip blobs.
const files = []
let newBlobs = 0
for (const abs of [...walk(join(src, 'out')), ...walk(join(src, 'resources'))]) {
  const data = readFileSync(abs)
  const hash = sha256(data)
  const path = relative(src, abs).split(sep).join('/')
  const reused = previousBlobs.get(hash)
  if (reused) {
    files.push({ path, sha256: hash, size: data.length, gzSize: reused.gzSize, url: reused.url })
    continue
  }
  const blob = join(filesDir, `${hash}.gz`)
  if (!existsSync(blob)) {
    writeFileSync(blob, gzipSync(data, { level: 9 }))
    newBlobs++
  }
  files.push({
    path,
    sha256: hash,
    size: data.length,
    gzSize: statSync(blob).size,
    ...(github ? { url: assetUrl(`${hash}.gz`) } : {})
  })
}
files.sort((a, b) => a.path.localeCompare(b.path))

// 2. Full installers (used when the Electron runtime changes). The first match per key is
// what the app installs by itself: the macOS .zip (bundle swap), the NSIS .exe (silent
// install) and the AppImage (self-replace); `-deb` keys serve installs from the .deb.
const full = {}
if (!flag('no-full') && existsSync(fullDir)) {
  const patterns = [
    ['darwin-arm64', /-mac-arm64\.zip$/],
    ['darwin-x64', /-mac-x64\.zip$/],
    ['win32-x64', /Setup-.*-x64\.exe$/],
    ['win32-arm64', /Setup-.*-arm64\.exe$/],
    ['linux-x64', /-linux-x86_64\.AppImage$/],
    ['linux-arm64', /-linux-arm64\.AppImage$/],
    ['linux-x64-deb', /-linux-amd64\.deb$/],
    ['linux-arm64-deb', /-linux-arm64\.deb$/]
  ]
  const fallbacks = [
    ['darwin-arm64', /-mac-arm64\.dmg$/],
    ['darwin-x64', /-mac-x64\.dmg$/],
    ['win32-x64', /-win-x64\.zip$/],
    ['linux-x64', /-linux-x64\.tar\.gz$/]
  ]
  const names = readdirSync(fullDir)
  for (const [key, re] of [...patterns, ...fallbacks]) {
    if (full[key]) continue
    const name = names.find((n) => re.test(n))
    if (!name) continue
    const from = join(fullDir, name)
    let url = assetUrl(name)
    if (!github) {
      url = `full/${version}/${name}`
      const dest = join(outDir, url)
      mkdirSync(dirname(dest), { recursive: true })
      if (!existsSync(dest) || statSync(dest).size !== statSync(from).size) copyFileSync(from, dest)
    }
    full[key] = { name, url, sha512: await sha512File(from), size: statSync(from).size }
  }
}

// 3. Manifest + detached signature over its exact bytes.
const manifest = {
  schema: 1,
  version,
  date: new Date().toISOString(),
  ...(notes ? { notes } : {}),
  electron,
  bootstrapApi,
  files,
  ...(Object.keys(full).length ? { full } : {})
}
const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
const signature = sign(null, raw, createPrivateKey(keyPem)).toString('base64')
// Clients only trust src/main/update-public-key.ts: refuse to publish what they would reject.
const publicPem = /`(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)`/.exec(
  readFileSync(join(root, 'src/main/update-public-key.ts'), 'utf8')
)?.[1]
if (!flag('skip-key-check') && (!publicPem || !verify(null, raw, createPublicKey(publicPem), Buffer.from(signature, 'base64')))) {
  console.error('The signing key does not match src/main/update-public-key.ts — installed apps would reject this update.')
  console.error('Use the private key generated with that public key, or run `npm run update:keygen -- --force` and ship new installers.')
  process.exit(1)
}
writeFileSync(join(outDir, 'latest.json'), raw)
writeFileSync(join(outDir, 'latest.json.sig'), signature + '\n')
if (!github) {
  mkdirSync(join(outDir, 'versions'), { recursive: true })
  writeFileSync(join(outDir, 'versions', `${version}.json`), raw)
  writeFileSync(join(outDir, 'versions', `${version}.json.sig`), signature + '\n')
}

// 4. Summary.
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
const allGz = files.reduce((n, f) => n + f.gzSize, 0)
console.log(`Published ${version} → ${outDir}`)
console.log(`  electron ${electron}, bootstrap API ${bootstrapApi}`)
console.log(`  ${files.length} files, ${mb(allGz)} compressed in total, ${newBlobs} new blobs`)
if (previous) {
  // Clients reuse a local file when the same path has the same content hash.
  const known = new Set(previous.files.map((f) => `${f.path}:${f.sha256}`))
  const changed = files.filter((f) => !known.has(`${f.path}:${f.sha256}`))
  const sameRuntime = previous.electron === electron
  console.log(
    `  update from ${previous.version}: ${changed.length} changed files, ${mb(changed.reduce((n, f) => n + f.gzSize, 0))} to download` +
      (sameRuntime ? '' : ' — Electron changed, clients need the full installer')
  )
}
for (const [key, p] of Object.entries(full)) console.log(`  full ${key}: ${p.name} (${mb(p.size)})`)
if (github) {
  console.log(`  ${previousBlobs.size ? `${files.filter((f) => !f.url.startsWith(ownAssets)).length} files reuse blobs of earlier releases` : 'no previous release: every blob is uploaded'}`)
  console.log(`Upload everything in ${outDir} (plus the installers) to the release ${github}@${tag}.`)
} else {
  console.log('Upload the whole folder to the URL configured as "markflow.updateUrl" in package.json.')
}
