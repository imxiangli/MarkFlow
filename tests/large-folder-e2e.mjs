/**
 * A large workspace must not slow the app down: the folder is watched with a single native
 * handle (macOS / Windows), changes still reach the tree, and quitting is quick.
 *
 *   npm run build && node tests/large-folder-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'markflow-large-'))
const big = join(work, 'big')
for (let a = 0; a < 40; a++) {
  for (let b = 0; b < 50; b++) {
    const dir = join(big, `area${String(a).padStart(2, '0')}`, `topic${String(b).padStart(2, '0')}`)
    mkdirSync(dir, { recursive: true })
    for (let c = 0; c < 3; c++) writeFileSync(join(dir, `note${c}.md`), `# Note ${a}-${b}-${c}\n`)
  }
}

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const native = process.platform === 'darwin' || process.platform === 'win32'

const t0 = Date.now()
const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, big],
  env: { ...process.env, MARKFLOW_USER_DATA: join(work, 'profile') }
})
const page = await app.firstWindow()
try {
  console.log('▶ open a folder with 2,040 sub-folders and 6,000 notes')
  await page.waitForSelector('.tree-row', { timeout: 30000 })
  check(true, `tree shown after ${Date.now() - t0} ms`)
  await sleep(1500)
  const handles = await app.evaluate(() => process.getActiveResourcesInfo().filter((x) => x === 'FSEventWrap').length)
  check(!native || handles <= 3, `${handles} native watcher handle(s)`)

  console.log('▶ changes still reach the tree')
  writeFileSync(join(big, 'brand-new.md'), '# new\n')
  const added = await page
    .waitForFunction(() => [...document.querySelectorAll('.tree-row .tree-name')].some((e) => e.textContent === 'brand-new.md'), null, { timeout: 5000 })
    .then(() => true, () => false)
  check(added, 'new file appears in the tree')
  rmSync(join(big, 'area00'), { recursive: true, force: true })
  const removed = await page
    .waitForFunction(() => ![...document.querySelectorAll('.tree-row .tree-name')].some((e) => e.textContent === 'area00'), null, { timeout: 5000 })
    .then(() => true, () => false)
  check(removed, 'deleted folder disappears from the tree')

  console.log('▶ quitting is quick')
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', r))
  const t1 = Date.now()
  await app.evaluate(({ app }) => app.quit())
  const done = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)])
  const ms = Date.now() - t1
  check(done && ms < 3000, `quit took ${ms} ms`)
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll large-folder checks passed')
process.exit(failures ? 1 : 0)
