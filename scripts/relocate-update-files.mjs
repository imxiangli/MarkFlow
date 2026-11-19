/**
 * One-off: moves a published release's app files into the shared files release.
 *
 *   node scripts/relocate-update-files.mjs --github <owner/repo> --manifest <latest.json>
 *     [--files-tag update-files] [--out <dir>]
 *
 * Downloads every app file the manifest points at (checking its SHA-256) into <out>/files/,
 * rewrites the manifest to point at --files-tag, signs it again and writes <out>/latest.json,
 * <out>/latest.json.sig and <out>/old-assets.txt (the asset names that can be removed from the
 * version release once the new manifest is live). Everything else in the manifest is unchanged.
 * Used by .github/workflows/move-update-files.yml.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { signingKey, signManifest } from './update-signing.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const github = opt('github')
const filesTag = opt('files-tag', 'update-files')
const out = resolve(opt('out', 'relocated'))
if (!github || !/^[\w.-]+\/[\w.-]+$/.test(github) || !opt('manifest')) {
  console.error('Usage: node scripts/relocate-update-files.mjs --github <owner/repo> --manifest <latest.json> [--files-tag tag] [--out dir]')
  process.exit(1)
}
const key = signingKey()
const manifest = JSON.parse(readFileSync(opt('manifest'), 'utf8'))
const target = `https://github.com/${github}/releases/download/${encodeURIComponent(filesTag)}/`
const versionAssets = `https://github.com/${github}/releases/download/${encodeURIComponent(`v${manifest.version}`)}/`
mkdirSync(join(out, 'files'), { recursive: true })

const old = new Set()
let moved = 0
for (const f of manifest.files) {
  const name = `${f.sha256}.gz`
  if (f.url?.startsWith(target)) continue
  if (!f.url) throw new Error(`${f.path} has no url`)
  const res = await fetch(f.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${f.url}`)
  const gz = Buffer.from(await res.arrayBuffer())
  const data = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz
  if (data.length !== f.size || createHash('sha256').update(data).digest('hex') !== f.sha256) {
    throw new Error(`checksum mismatch: ${f.path}`)
  }
  writeFileSync(join(out, 'files', name), gz)
  if (f.url.startsWith(versionAssets)) old.add(decodeURIComponent(f.url.slice(versionAssets.length)))
  f.url = target + name
  moved++
}

const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(out, 'latest.json'), raw)
writeFileSync(join(out, 'latest.json.sig'), signManifest(raw, key) + '\n')
writeFileSync(join(out, 'old-assets.txt'), [...old].sort().join('\n') + (old.size ? '\n' : ''))
console.log(`${manifest.version}: ${moved} app files now point at ${filesTag}; ${old.size} assets can leave v${manifest.version}`)
