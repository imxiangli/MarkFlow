/**
 * Checks a deployed update feed the same way the app does.
 *
 *   node scripts/verify-update-server.mjs https://updates.example.com/markflow/ [--sample 30] [--skip-full]
 *
 * Verifies the manifest signature with the public key compiled into the app, downloads the
 * app files and compares hashes, checks the installers exist, and warns about headers that
 * break or slow down updates (caching of latest.json, re-encoded .gz blobs).
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
let base = args.find((a) => /^https?:\/\//.test(a))
if (!base) {
  console.error('Usage: node scripts/verify-update-server.mjs <update URL> [--sample N] [--skip-full]')
  process.exit(1)
}
if (!base.endsWith('/')) base += '/'
const sample = Number(opt('sample', '0'))
const skipFull = args.includes('--skip-full')

const keySrc = readFileSync(join(root, 'src/main/update-public-key.ts'), 'utf8')
const publicKey = createPublicKey(/`([^`]+)`/.exec(keySrc)[1])
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

let errors = 0
let warnings = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const warn = (m) => {
  warnings++
  console.log(`  ! ${m}`)
}
const fail = (m) => {
  errors++
  console.log(`  ✗ ${m}`)
}

async function get(path, init) {
  const res = await fetch(base + path, { redirect: 'follow', ...init })
  return res
}

console.log(`Checking ${base}`)

// 1. Manifest + signature
const res = await get(`latest.json?t=${Date.now()}`, { headers: { 'accept-encoding': 'identity' } })
if (!res.ok) {
  fail(`latest.json → HTTP ${res.status}`)
  process.exit(1)
}
const raw = Buffer.from(await res.arrayBuffer())
const cc = res.headers.get('cache-control') ?? ''
if (/no-cache|no-store|max-age=0/.test(cc)) ok(`latest.json reachable, Cache-Control: ${cc}`)
else warn(`latest.json Cache-Control is "${cc || 'not set'}" — clients may see new releases late (use "no-cache")`)

let manifest
try {
  manifest = JSON.parse(raw.toString('utf8'))
} catch {
  fail('latest.json is not valid JSON')
  process.exit(1)
}
for (const sigPath of [`versions/${manifest.version}.json.sig`, 'latest.json.sig']) {
  const r = await get(`${sigPath}?t=${Date.now()}`)
  if (!r.ok) {
    fail(`${sigPath} → HTTP ${r.status}`)
    continue
  }
  const sig = Buffer.from((await r.text()).trim(), 'base64')
  if (verify(null, raw, publicKey, sig)) ok(`${sigPath} matches latest.json (signed with the app's key)`)
  else fail(`${sigPath} does not verify latest.json — wrong key or files out of sync`)
}
console.log(`  version ${manifest.version}, electron ${manifest.electron}, ${manifest.files.length} files`)

// 2. Content-addressed app files
let files = manifest.files
if (sample > 0 && sample < files.length) files = [...files].sort(() => Math.random() - 0.5).slice(0, sample)
let encoded = 0
let badCache = 0
let bytes = 0
let next = 0
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < files.length) {
      const f = files[next++]
      try {
        const r = await get(`files/${f.sha256}.gz`, { headers: { 'accept-encoding': 'identity' } })
        if (!r.ok) {
          fail(`files/${f.sha256}.gz (${f.path}) → HTTP ${r.status}`)
          continue
        }
        if (r.headers.get('content-encoding')) encoded++
        if (!/immutable|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '')) badCache++
        let body = Buffer.from(await r.arrayBuffer())
        bytes += body.length
        if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body)
        if (body.length !== f.size || sha256(body) !== f.sha256) fail(`hash mismatch for ${f.path}`)
      } catch (e) {
        fail(`files/${f.sha256}.gz (${f.path}): ${e.message}`)
      }
    }
  })
)
if (!errors) ok(`${files.length}${sample ? ` sampled` : ''} app files downloaded and verified (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
if (encoded) warn(`${encoded} blobs were sent with Content-Encoding — works, but disable compression for *.gz`)
if (badCache) warn(`${badCache} blobs lack a long Cache-Control — fine, but "immutable" saves bandwidth`)

// 3. Installers for full updates
if (!skipFull) {
  for (const [key, p] of Object.entries(manifest.full ?? {})) {
    try {
      const url = /^https?:/.test(p.url) ? p.url : base + p.url
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      const len = Number(r.headers.get('content-length') ?? 0)
      if (!r.ok) fail(`full ${key}: ${p.url} → HTTP ${r.status}`)
      else if (len && len !== p.size) fail(`full ${key}: size ${len} ≠ ${p.size}`)
      else ok(`full ${key}: ${p.name} (${(p.size / 1024 / 1024).toFixed(1)} MB)`)
    } catch (e) {
      fail(`full ${key}: ${e.message}`)
    }
  }
}

console.log(errors ? `\n${errors} error(s), ${warnings} warning(s)` : `\nUpdate server OK${warnings ? ` (${warnings} warning(s))` : ''}`)
process.exit(errors ? 1 : 0)
