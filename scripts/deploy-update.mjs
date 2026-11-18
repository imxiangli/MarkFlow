/**
 * Uploads the update feed (release/update by default) to the update server.
 *
 *   node scripts/deploy-update.mjs <target> [--from release/update] [--no-full] [--dry-run]
 *
 * <target> is either
 *   - a local folder, e.g. server/data (the Docker/Caddy volume) or /srv/markflow
 *   - an rsync-over-SSH destination, e.g. deploy@updates.example.com:/srv/markflow
 *
 * Order matters: content (files/, full/, versions/) goes first and latest.json last, so
 * clients never see a manifest that points at files which are not uploaded yet. Nothing is
 * deleted on the server: older clients may still need older blobs while they update.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--from'))
const from = resolve(opt('from', join(root, 'release/update')))
const dryRun = flag('dry-run')
const noFull = flag('no-full')

if (!target) {
  console.error('Usage: node scripts/deploy-update.mjs <local-dir | user@host:/path> [--from dir] [--no-full] [--dry-run]')
  process.exit(1)
}
if (!existsSync(join(from, 'latest.json')) || !existsSync(join(from, 'latest.json.sig'))) {
  console.error(`${from} has no latest.json — run \`npm run release:update\` first.`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(from, 'latest.json'), 'utf8'))
if (!existsSync(join(from, 'versions', `${manifest.version}.json.sig`))) {
  console.error(`versions/${manifest.version}.json.sig is missing in ${from}`)
  process.exit(1)
}
const contentDirs = ['files', 'versions', ...(noFull ? [] : ['full'])].filter((d) => existsSync(join(from, d)))
const isRemote = /^[^/\\]+:/.test(target) && !/^[a-zA-Z]:[\\/]/.test(target)

console.log(`Deploying MarkFlow ${manifest.version} from ${from}`)
console.log(`  → ${target}${dryRun ? '  (dry run)' : ''}`)
if (noFull && manifest.full) console.log('  ! --no-full: installers referenced by latest.json will not be uploaded')

function run(cmd, cmdArgs) {
  console.log(`  $ ${cmd} ${cmdArgs.join(' ')}`)
  if (dryRun) return
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n${cmd} failed (exit ${r.status}). latest.json was NOT updated, clients keep the previous release.`)
    process.exit(r.status ?? 1)
  }
}

if (isRemote) {
  const dest = target.endsWith('/') ? target : target + '/'
  const ssh = ['-e', process.env.MARKFLOW_DEPLOY_SSH ?? 'ssh']
  // 1. content (immutable, additive)
  run('rsync', ['-a', '--partial', ...ssh, ...contentDirs.map((d) => join(from, d)), dest])
  // 2. manifest last
  run('rsync', ['-a', ...ssh, join(from, 'latest.json.sig'), join(from, 'latest.json'), dest])
} else {
  const dest = resolve(target)
  const copy = (name) => {
    console.log(`  copy ${name}`)
    if (!dryRun) cpSync(join(from, name), join(dest, name), { recursive: true, force: true })
  }
  if (!dryRun) mkdirSync(dest, { recursive: true })
  contentDirs.forEach(copy)
  copy('latest.json.sig')
  copy('latest.json')
}

console.log(`\nDone. Check it with:\n  node scripts/verify-update-server.mjs <update URL>`)
