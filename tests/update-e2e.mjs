/**
 * End-to-end test of the incremental updater against the *packaged* app.
 *
 *   npm run build && npx electron-builder --mac --dir --arm64 && node tests/update-e2e.mjs
 *
 * Starts a local static update server, publishes versions with scripts/release-update.mjs
 * and drives the packaged app with Playwright through: delta download → restart into the
 * hot version → runtime change (full installer) → tampered manifest → broken update rollback.
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startUpdateServer } from '../server/update-server.mjs'
import { closeApp } from './helpers.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const defaultApp = {
  darwin: `release/${pkg.version}/mac-${process.arch}/MarkFlow.app/Contents/MacOS/MarkFlow`,
  win32: `release/${pkg.version}/win-unpacked/MarkFlow.exe`,
  linux: `release/${pkg.version}/linux-unpacked/markflow`
}[process.platform]
const exe = resolve(root, process.argv[2] ?? defaultApp)
if (!existsSync(exe)) {
  console.error(`Packaged app not found: ${exe}`)
  process.exit(1)
}

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}

const work = mkdtempSync(join(tmpdir(), 'markflow-update-'))
const srv = join(work, 'srv')
const profile = join(work, 'profile')
const downloads = join(work, 'downloads')
mkdirSync(srv, { recursive: true })
mkdirSync(downloads, { recursive: true })
mkdirSync(join(root, 'tests/output'), { recursive: true })

// --- the production update server (server/update-server.mjs), recording requests ---
const requests = []
const server = await startUpdateServer({
  root: srv,
  port: 0,
  host: '127.0.0.1',
  prefix: '/markflow/',
  log: (line) => requests.push(line.split(' ')[1].replace(/^\/markflow/, '').replace(/\?.*$/, ''))
})
const baseUrl = `http://127.0.0.1:${server.address().port}/markflow/`

const publish = (version, srcDir, extra = []) =>
  execFileSync(process.execPath, [join(root, 'scripts/release-update.mjs'), '--src', srcDir, '--out', srv, '--version', version, ...extra], {
    encoding: 'utf8'
  })

/** Copy of the current build with one main-process file changed. */
function makeTree(name, mutate) {
  const dir = join(work, name)
  cpSync(join(root, 'out'), join(dir, 'out'), { recursive: true })
  cpSync(join(root, 'resources'), join(dir, 'resources'), { recursive: true })
  mutate(dir)
  return dir
}

async function launch() {
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: { ...process.env, MARKFLOW_USER_DATA: profile, MARKFLOW_UPDATE_URL: baseUrl, MARKFLOW_DOWNLOAD_DIR: downloads }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20000 })
  return { app, page }
}

const hotState = () => JSON.parse(readFileSync(join(profile, 'updates/state.json'), 'utf8'))

let app, page
try {
  console.log('▶ bootstrap starts nothing before choosing a version')
  const boot = readFileSync(join(root, 'out/main/bootstrap.js'), 'utf8')
  check(!/require\(["']\.\/index\.js["']\)/.test(boot), 'bootstrap.js does not statically require index.js')

  // Baseline published version = the installed one, so the server is "up to date".
  publish(pkg.version, root, ['--no-full'])
  const tree101 = makeTree('v101', (d) => appendFileSync(join(d, 'out/main/index.js'), '\n// 1.0.1 change\n'))

  console.log('▶ installed version is up to date')
  ;({ app, page } = await launch())
  let state = await page.evaluate(() => window.mf.checkForUpdates())
  check(state.status === 'up-to-date' && state.currentVersion === pkg.version, `status ${state.status}, version ${state.currentVersion}`)

  console.log('▶ incremental update downloads only changed files')
  const out101 = publish('1.0.1', tree101, ['--no-full', '--notes', 'Test release 1.0.1'])
  console.log(out101.trim().split('\n').map((l) => '    ' + l).join('\n'))
  requests.length = 0
  state = await page.evaluate(() => window.mf.checkForUpdates())
  const blobRequests = requests.filter((p) => p.startsWith('/files/'))
  check(state.status === 'ready' && state.latestVersion === '1.0.1', `status ${state.status} → ${state.latestVersion}`)
  check(state.filesToDownload === 1 && blobRequests.length === 1, `downloaded ${blobRequests.length} of ${state.filesTotal} files (${state.total} bytes)`)
  check(
    readFileSync(join(profile, 'updates/1.0.1/out/main/index.js'), 'utf8').includes('1.0.1 change'),
    'new version staged in userData/updates/1.0.1'
  )
  await page.waitForTimeout(300)
  await page.evaluate(() => document.querySelector('.status-update')?.textContent ?? '').then((t) =>
    check(t.includes('1.0.1'), `status bar shows "${t}"`)
  )
  await closeApp(app)

  console.log('▶ restart runs the hot version')
  ;({ app, page } = await launch())
  const init = await page.evaluate(() => window.mf.getInitialState())
  check(init.version === '1.0.1', `app reports version ${init.version}`)
  await page.waitForTimeout(800)
  state = await page.evaluate(() => window.mf.getUpdateState())
  check(state.hot === true && state.baseVersion === pkg.version, `hot=${state.hot}, base=${state.baseVersion}`)
  check(!hotState().booting, 'successful boot confirmed (crash guard cleared)')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', 'settings'))
  await page.click('.settings-nav button:has-text("更新"), .settings-nav button:has-text("Updates")')
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(root, 'tests/output/update-settings.png') })
  await page.keyboard.press('Escape')

  console.log('▶ second incremental update reuses files from the hot version')
  const tree102 = makeTree('v102', (d) => {
    appendFileSync(join(d, 'out/main/index.js'), '\n// 1.0.1 change\n// 1.0.2 change\n')
    appendFileSync(join(d, 'out/preload/index.js'), '\n// 1.0.2 preload change\n')
  })
  publish('1.0.2', tree102, ['--no-full'])
  requests.length = 0
  state = await page.evaluate(() => window.mf.checkForUpdates())
  check(state.status === 'ready' && state.filesToDownload === 2, `1.0.1 → 1.0.2: ${state.filesToDownload} files downloaded`)
  await closeApp(app)
  ;({ app, page } = await launch())
  check((await page.evaluate(() => window.mf.getInitialState())).version === '1.0.2', 'restarted into 1.0.2')
  await page.waitForTimeout(800)
  const dirs = execFileSync('ls', [join(profile, 'updates')], { encoding: 'utf8' }).trim().split('\n')
  check(!dirs.includes('1.0.1'), `old version cleaned up (${dirs.join(', ')})`)

  console.log('▶ runtime change requires the full installer')
  const fakeFull = join(work, 'full')
  mkdirSync(fakeFull, { recursive: true })
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const fullName = { darwin: `MarkFlow-1.1.0-mac-${arch}.dmg`, win32: `MarkFlow-Setup-1.1.0-${arch}.exe`, linux: 'MarkFlow-1.1.0-linux-x86_64.AppImage' }[process.platform]
  writeFileSync(join(fakeFull, fullName), Buffer.alloc(256 * 1024, 7))
  publish('1.1.0', tree102, ['--electron', '99.0.0', '--full-dir', fakeFull])
  state = await page.evaluate(() => window.mf.checkForUpdates())
  check(state.status === 'full-available' && state.fullSize === 256 * 1024, `status ${state.status}, installer ${state.fullSize} bytes`)
  state = await page.evaluate(() => window.mf.downloadUpdate())
  check(state.status === 'full-ready' && existsSync(state.installerPath ?? ''), `installer downloaded → ${state.installerPath}`)

  console.log('▶ tampered manifest is rejected')
  const latest = join(srv, 'latest.json')
  writeFileSync(latest, readFileSync(latest, 'utf8').replace('"1.1.0"', '"1.1.0-tampered"').replace('"date"', '"tampered": true, "date"'))
  await closeApp(app)
  ;({ app, page } = await launch())
  state = await page.evaluate(() => window.mf.checkForUpdates())
  check(state.status === 'error' && /signature/i.test(state.error ?? ''), `status ${state.status}: ${state.error}`)
  await closeApp(app)

  console.log('▶ broken update falls back to the bundled version')
  const s = hotState()
  mkdirSync(join(profile, 'updates/1.0.3/out/main'), { recursive: true })
  writeFileSync(join(profile, 'updates/1.0.3/out/main/index.js'), 'throw new Error("broken build")\n')
  s.current = { ...s.current, version: '1.0.3', dir: '1.0.3' }
  writeFileSync(join(profile, 'updates/state.json'), JSON.stringify(s))
  ;({ app, page } = await launch())
  const v = (await page.evaluate(() => window.mf.getInitialState())).version
  check(v === pkg.version, `fell back to bundled ${v}`)
  check(hotState().failed?.includes('1.0.3'), 'broken version recorded as failed')
  await closeApp(app)
} catch (err) {
  console.error(err)
  failures++
} finally {
  if (app) await closeApp(app)
  server.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll update checks passed')
process.exit(failures ? 1 : 0)
