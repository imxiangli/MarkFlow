/**
 * Checks a GitHub Releases update feed the way the app reads it: the signature against the
 * public key in src/main/update-public-key.ts, every app file (downloaded, unzipped, SHA-256 and
 * size compared) and every installer (reachable, same size).
 *
 *   node scripts/verify-github-feed.mjs <owner/repo>                     the published feed
 *   node scripts/verify-github-feed.mjs --manifest latest.json --sig latest.json.sig
 *                                                                        a feed before publishing
 *   --no-installers   skip the installers (not uploaded yet)
 */
import { createHash, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { appPublicKey } from './update-signing.mjs'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const valued = new Set(['--manifest', '--sig'])
const repo = args.find((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(args[i - 1])))
const CONCURRENCY = 8

async function get(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (i >= attempts) throw new Error(`${url}: ${err.message}`)
      await new Promise((r) => setTimeout(r, 1000 * i))
    }
  }
}

let raw, sig
if (opt('manifest')) {
  raw = readFileSync(opt('manifest'))
  sig = readFileSync(opt('sig') ?? `${opt('manifest')}.sig`, 'utf8')
} else if (repo) {
  raw = await get(`https://github.com/${repo}/releases/latest/download/latest.json`)
  const version = JSON.parse(raw.toString('utf8')).version
  sig = (await get(`https://github.com/${repo}/releases/download/v${version}/latest.json.sig`)).toString('utf8')
} else {
  console.error('Usage: node scripts/verify-github-feed.mjs <owner/repo> | --manifest <latest.json> [--sig <file>]')
  process.exit(1)
}

const problems = []
const m = JSON.parse(raw.toString('utf8'))
const signed = verify(null, raw, appPublicKey(), Buffer.from(sig.trim(), 'base64'))
if (!signed) problems.push('signature does not verify against src/main/update-public-key.ts')
console.log(`${m.version}: signature ${signed ? 'valid' : 'INVALID'}, ${m.files.length} app files, ${Object.keys(m.full ?? {}).length} installers`)

const queue = [...m.files]
let checked = 0
const hosts = new Set()
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        if (!f.url) throw new Error('no url')
        hosts.add(f.url.replace(/[^/]+$/, ''))
        const gz = await get(f.url)
        const data = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz
        if (data.length !== f.size || createHash('sha256').update(data).digest('hex') !== f.sha256) throw new Error('checksum mismatch')
        checked++
      } catch (err) {
        problems.push(`${f.path}: ${err.message}`)
      }
    }
  })
)
console.log(`  app files: ${checked}/${m.files.length} OK, served from ${[...hosts].join(', ')}`)

for (const [key, p] of args.includes('--no-installers') ? [] : Object.entries(m.full ?? {})) {
  try {
    const res = await fetch(p.url, { method: 'HEAD', redirect: 'follow' })
    const size = Number(res.headers.get('content-length'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (size !== p.size) throw new Error(`size ${size}, manifest says ${p.size}`)
    console.log(`  ${key.padEnd(16)} ${p.name} OK`)
  } catch (err) {
    problems.push(`installer ${key} (${p.name}): ${err.message}`)
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.slice(0, 20).join('\n  ')}`)
  process.exit(1)
}
console.log('Feed OK')
