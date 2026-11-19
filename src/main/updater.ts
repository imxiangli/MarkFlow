/**
 * Auto-updater with incremental (file-level) updates.
 *
 * By default updates come from the GitHub Releases of `markflow.github` in package.json
 * (built and published by .github/workflows/build.yml):
 *   releases/latest/download/latest.json      signed manifest of the newest release
 *   releases/download/v<ver>/latest.json.sig  its signature, read from the immutable tag
 *   releases/download/v<ver>/<sha256>.gz      app files; the manifest gives each one's URL
 *   releases/download/v<ver>/<installer>      macOS .zip, Windows .exe, Linux AppImage / .deb
 *
 * A self-hosted feed (markflow.updateUrl, the settings field or $MARKFLOW_UPDATE_URL) uses
 * this layout instead (static hosting is enough, see scripts/release-update.mjs):
 *   <base>/latest.json          signed manifest (UpdateManifest)
 *   <base>/latest.json.sig      base64 Ed25519 signature of latest.json's exact bytes
 *   <base>/files/<sha256>.gz    content-addressed app files
 *   <base>/full/<ver>/<name>    full installers, only needed when the Electron runtime changes
 *
 * A hot update copies unchanged files from the running app and downloads only the rest,
 * then src/bootstrap picks the new version up on the next launch. When the Electron runtime
 * changes, the full package is downloaded and installed on restart: the .app bundle is swapped
 * on macOS, the NSIS installer runs silently on Windows and the AppImage replaces itself on
 * Linux. Other installs (read-only locations, .deb, portable zip) get the file to open by hand.
 */
import { app, net, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  createWriteStream,
  existsSync,
  promises as fs,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { markflow as packageConfig } from '../../package.json'
import { compareVersions, type FullPackage, type UpdateManifest, type UpdateState } from '@shared/update'
import { UPDATE_PUBLIC_KEY } from './update-public-key'
import { getStore } from './store'
import { broadcast } from './windows'

const CHECK_DELAY = 15_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT = 30_000
const CONCURRENCY = 4

interface HotState {
  current?: { version: string; dir: string; electron: string; bootstrapApi: number }
  failed?: string[]
  booting?: { version: string; attempts: number }
}

export function appVersion(): string {
  return process.env['MARKFLOW_APP_VERSION'] || app.getVersion()
}

function appRoot(): string {
  return process.env['MARKFLOW_APP_ROOT'] || app.getAppPath()
}

const bootstrapApi = (): number => Number(process.env['MARKFLOW_BOOTSTRAP_API'] || 0)
const updatesDir = (): string => join(app.getPath('userData'), 'updates')
const statePath = (): string => join(updatesDir(), 'state.json')

function readHotState(): HotState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as HotState
  } catch {
    return {}
  }
}

function writeHotState(state: HotState): void {
  mkdirSync(updatesDir(), { recursive: true })
  writeFileSync(statePath() + '.tmp', JSON.stringify(state, null, 2))
  renameSync(statePath() + '.tmp', statePath())
}

interface Feed {
  /** Folder that holds latest.json, with a trailing slash. */
  base: string
  /** Immutable signature of one version's manifest, tried before base + latest.json.sig. */
  versionSig: (version: string) => string
  /** Add a cache-busting query to latest.json (GitHub's redirects are never cached). */
  bust: boolean
  label: string
}

function githubFeed(repo: string): Feed {
  const releases = `https://github.com/${repo}/releases`
  return {
    base: `${releases}/latest/download/`,
    versionSig: (v) => `${releases}/download/v${v}/latest.json.sig`,
    bust: false,
    label: `GitHub ${repo}`
  }
}

const GITHUB_REPO = /^(?:github:|https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i

/**
 * The update source, in order: $MARKFLOW_UPDATE_URL (tests), the settings field, the URL baked
 * into package.json, then the GitHub repository from package.json. A URL or "github:owner/repo"
 * pointing at a GitHub repository reads that repository's releases.
 */
function feed(): Feed | null {
  const custom = (
    process.env['MARKFLOW_UPDATE_URL'] ||
    getStore().settings.updateUrl.trim() ||
    (packageConfig?.updateUrl ?? '')
  ).trim()
  if (custom) {
    const gh = /^(github:|https?:\/\/github\.com\/)/i.test(custom) ? GITHUB_REPO.exec(custom) : null
    if (gh) return githubFeed(gh[1])
    const base = custom.endsWith('/') ? custom : custom + '/'
    return { base, versionSig: (v) => `${base}versions/${v}.json.sig`, bust: true, label: base }
  }
  const repo = GITHUB_REPO.exec((packageConfig?.github ?? '').trim())
  return repo ? githubFeed(repo[1]) : null
}

function resolveUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : (feed()?.base ?? '') + path.replace(/^\/+/, '')
}

/** How a full package gets installed on this machine. */
type InstallMode =
  | 'mac-app' // unzip next to the running .app and swap the bundle after quitting
  | 'nsis' // run the NSIS installer silently after quitting; it relaunches the app
  | 'appimage' // replace the running AppImage file and relaunch it
  | 'open' // hand the file to the OS (dmg, .deb, interactive installer)
  | 'reveal' // show the file in the file manager

/** The running .app bundle, when it can be replaced in place (not translocated, writable). */
function macBundle(): string | null {
  const m = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath)
  if (!m || m[1].includes('/AppTranslocation/')) return null
  try {
    accessSync(dirname(m[1]), fsConstants.W_OK)
    accessSync(m[1], fsConstants.W_OK)
    return m[1]
  } catch {
    return null
  }
}

/** The installed AppImage, when its folder is writable. */
function appImagePath(): string | null {
  const p = process.env['APPIMAGE']
  if (!p) return null
  try {
    accessSync(dirname(p), fsConstants.W_OK)
    return p
  } catch {
    return null
  }
}

/** Installed with the NSIS installer (not the portable zip): its uninstaller sits next to the exe. */
function nsisInstalled(): boolean {
  return existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`))
}

function pickFull(m: UpdateManifest): { pkg: FullPackage; mode: InstallMode } | null {
  const id = `${process.platform}-${process.arch}`
  const name = (p: FullPackage): string => p.name || basename(p.url)
  if (process.platform === 'linux' && !process.env['APPIMAGE']) {
    // The .deb installs into /opt/<productName>; its users get the .deb rather than an AppImage.
    const deb = m.full?.[`${id}-deb`]
    if (deb && process.execPath.startsWith('/opt/')) return { pkg: deb, mode: 'open' }
  }
  const pkg = m.full?.[id]
  if (!pkg) return null
  const file = name(pkg)
  if (process.platform === 'darwin') return { pkg, mode: file.endsWith('.zip') && macBundle() ? 'mac-app' : 'open' }
  if (process.platform === 'win32') return { pkg, mode: /\.exe$/i.test(file) && nsisInstalled() ? 'nsis' : 'open' }
  return { pkg, mode: file.endsWith('.AppImage') && appImagePath() ? 'appimage' : 'reveal' }
}

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((res, rej) => execFile(cmd, args, (err) => (err ? rej(err) : res())))

/**
 * Waits for the app to exit, swaps in the new bundle (restoring the old one if that fails)
 * and opens it. Args: pid, current bundle, new bundle.
 */
const MAC_SWAP_SCRIPT = `
pid="$1"; app="$2"; new="$3"; i=0
while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 600 ] && exit 1; sleep 0.1; done
old="$app.old-update"
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$old"; else rm -rf "$app"; mv "$old" "$app"; fi
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
open "$app"
`

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/** Reject manifest paths that could escape the update directory. */
function safeRelPath(p: string): string | null {
  if (!p || isAbsolute(p) || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '')) return null
  if (!/^(out|resources)\//.test(p) && p !== 'package.json') return null
  return normalize(p)
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, cache: 'no-store' } as RequestInit)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBuffer(url: string, onChunk: (n: number) => void): Promise<Buffer> {
  const res = await fetchWithTimeout(url)
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    onChunk(value.length)
  }
  return Buffer.concat(chunks)
}

function verifyManifest(raw: Buffer, signatureB64: string): UpdateManifest {
  const key = createPublicKey(UPDATE_PUBLIC_KEY)
  const sig = Buffer.from(signatureB64.trim(), 'base64')
  if (!sig.length || !verify(null, raw, key, sig)) throw new Error('Update manifest signature is invalid')
  const m = JSON.parse(raw.toString('utf8')) as UpdateManifest
  if (m.schema !== 1 || typeof m.version !== 'string' || !Array.isArray(m.files) || typeof m.electron !== 'string') {
    throw new Error('Unsupported update manifest')
  }
  return m
}

function notesText(m: UpdateManifest): string | undefined {
  if (!m.notes) return undefined
  if (typeof m.notes === 'string') return m.notes
  const lang = app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  return m.notes[lang] ?? m.notes['en'] ?? Object.values(m.notes)[0]
}

class Updater {
  private state: UpdateState
  private manifest: UpdateManifest | null = null
  private busy = false
  private relaunchOnQuit = false
  private timer: NodeJS.Timeout | null = null
  /** Full package downloaded for an automatic install. */
  private fullReady: { mode: InstallMode; path: string } | null = null
  private installOnQuit = false

  constructor() {
    this.state = {
      status: 'idle',
      currentVersion: appVersion(),
      baseVersion: process.env['MARKFLOW_BASE_VERSION'] || app.getVersion(),
      hot: process.env['MARKFLOW_HOT'] === '1'
    }
  }

  private source(): string | undefined {
    try {
      return feed()?.label
    } catch {
      return undefined
    }
  }

  getState(): UpdateState {
    return this.state
  }

  private set(patch: Partial<UpdateState>, replace = false): UpdateState {
    const base = {
      currentVersion: this.state.currentVersion,
      baseVersion: this.state.baseVersion,
      hot: this.state.hot,
      lastChecked: this.state.lastChecked,
      source: this.source()
    }
    this.state = replace ? { ...base, status: 'idle', ...patch } : { ...this.state, ...patch }
    broadcast('mf:update-state', this.state)
    return this.state
  }

  private disabledReason(): string | null {
    if (!app.isPackaged && !process.env['MARKFLOW_FORCE_HOT']) return 'dev'
    if (!feed()) return 'no-url'
    return null
  }

  start(): void {
    this.state.source = this.source()
    const reason = this.disabledReason()
    if (reason) this.set({ status: 'disabled', disabledReason: reason }, true)
    const schedule = () => {
      if (getStore().settings.autoCheckUpdates) void this.check(false)
    }
    setTimeout(schedule, CHECK_DELAY)
    this.timer = setInterval(schedule, CHECK_INTERVAL)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async check(manual: boolean): Promise<UpdateState> {
    if (this.busy) return this.state
    const reason = this.disabledReason()
    if (reason) return this.set({ status: 'disabled', disabledReason: reason }, true)
    if (this.state.status === 'ready' || this.state.status === 'full-ready') return this.state
    this.busy = true
    this.set({ status: 'checking' }, true)
    try {
      const manifest = await this.fetchManifest()
      this.manifest = manifest
      const lastChecked = Date.now()
      if (compareVersions(manifest.version, appVersion()) <= 0) {
        return this.set({ status: 'up-to-date', latestVersion: manifest.version, lastChecked }, true)
      }
      const info = {
        latestVersion: manifest.version,
        notes: notesText(manifest),
        lastChecked,
        fullSize: pickFull(manifest)?.pkg.size
      }
      if (this.canHotUpdate(manifest)) {
        const hot = readHotState()
        if (hot.current?.version === manifest.version && existsSync(join(updatesDir(), hot.current.dir, 'out/main/index.js'))) {
          return this.set({ status: 'ready', ...info }, true)
        }
        this.set({ status: 'available', ...info }, true)
        if (manual || getStore().settings.autoDownloadUpdates) await this.downloadDelta(manifest)
        return this.state
      }
      return this.set({ status: 'full-available', ...info }, true)
    } catch (err) {
      return this.set({ status: 'error', error: (err as Error).message, lastChecked: Date.now() }, true)
    } finally {
      this.busy = false
    }
  }

  /**
   * latest.json is verified against the immutable signature of the version it claims
   * (versions/<version>.json.sig, or the release tagged v<version> on GitHub), which is in place
   * before latest.json changes — so a half-finished upload or a CDN serving a stale latest.json
   * never pairs a manifest with the wrong signature.
   */
  private async fetchManifest(): Promise<UpdateManifest> {
    const f = feed()
    if (!f) throw new Error('No update source configured')
    const bust = (url: string): string => (f.bust ? `${url}?t=${Date.now()}` : url)
    const raw = Buffer.from(await (await fetchWithTimeout(bust(`${f.base}latest.json`))).arrayBuffer())
    let claimed = ''
    try {
      claimed = String((JSON.parse(raw.toString('utf8')) as { version?: unknown }).version ?? '')
    } catch {
      throw new Error('latest.json is not valid JSON')
    }
    let sig: string
    try {
      if (!/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(claimed)) throw new Error('bad version')
      sig = await (await fetchWithTimeout(f.versionSig(claimed))).text()
    } catch {
      sig = await (await fetchWithTimeout(bust(`${f.base}latest.json.sig`))).text()
    }
    return verifyManifest(raw, sig)
  }

  private canHotUpdate(m: UpdateManifest): boolean {
    if (m.electron !== process.versions.electron) return false
    if (m.bootstrapApi > bootstrapApi()) return false
    if (!m.files.length) return false
    return !readHotState().failed?.includes(m.version)
  }

  /** Download what the user asked for: the delta when possible, else the installer. */
  async download(): Promise<UpdateState> {
    if (!this.manifest || this.busy) return this.state
    this.busy = true
    try {
      if (this.state.status === 'available') await this.downloadDelta(this.manifest)
      else if (this.state.status === 'full-available') await this.downloadFull()
    } catch (err) {
      this.set({ status: 'error', error: (err as Error).message })
    } finally {
      this.busy = false
    }
    return this.state
  }

  private async downloadDelta(m: UpdateManifest): Promise<void> {
    const root = appRoot()
    const staging = join(updatesDir(), `${m.version}.partial`)
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(staging, { recursive: true })

    // 1. Decide per file: reuse the local copy (same content hash) or download it.
    const toDownload: UpdateManifest['files'] = []
    const toCopy: { from: string; rel: string }[] = []
    for (const f of m.files) {
      const rel = safeRelPath(f.path)
      if (!rel) throw new Error(`Unsafe path in manifest: ${f.path}`)
      const local = join(root, rel)
      let reuse = false
      try {
        const st = await fs.stat(local)
        if (st.size === f.size) reuse = sha256(await fs.readFile(local)) === f.sha256
      } catch {
        reuse = false
      }
      if (reuse) toCopy.push({ from: local, rel })
      else toDownload.push(f)
    }
    const total = toDownload.reduce((n, f) => n + f.gzSize, 0)
    let downloaded = 0
    this.set({
      status: 'downloading',
      total,
      downloaded: 0,
      filesTotal: m.files.length,
      filesToDownload: toDownload.length,
      error: undefined
    })

    // 2. Copy unchanged files (from app.asar or the current hot version).
    for (const c of toCopy) {
      const dest = join(staging, c.rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, await fs.readFile(c.from))
    }

    // 3. Download changed files from the content-addressed store.
    let lastEmit = 0
    const queue = [...toDownload]
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const gz = await fetchBuffer(resolveUrl(f.url ?? `files/${f.sha256}.gz`), (n) => {
          downloaded += n
          if (Date.now() - lastEmit > 150) {
            lastEmit = Date.now()
            this.set({ downloaded })
          }
        })
        // Some hosts add "Content-Encoding: gzip" to .gz files, so the body may arrive already
        // decompressed. Accept whichever form matches the expected hash.
        let data = gz
        if (gz[0] === 0x1f && gz[1] === 0x8b) {
          try {
            const unzipped = gunzipSync(gz)
            if (unzipped.length === f.size && sha256(unzipped) === f.sha256) data = unzipped
          } catch {
            // not gzip after all
          }
        }
        if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`Checksum mismatch: ${f.path}`)
        const dest = join(staging, safeRelPath(f.path)!)
        await fs.mkdir(dirname(dest), { recursive: true })
        await fs.writeFile(dest, data)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toDownload.length) }, worker))
    this.set({ downloaded })

    // 4. Atomically publish the new version for the bootstrap loader.
    const target = join(updatesDir(), m.version)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
    const hot = readHotState()
    hot.current = { version: m.version, dir: m.version, electron: m.electron, bootstrapApi: m.bootstrapApi }
    delete hot.booting
    writeHotState(hot)
    this.set({ status: 'ready' })
  }

  private async downloadFull(): Promise<void> {
    const picked = this.manifest ? pickFull(this.manifest) : null
    if (!picked) throw new Error(`No installer for ${process.platform}-${process.arch}`)
    const { pkg, mode } = picked
    const auto = mode === 'mac-app' || mode === 'nsis' || mode === 'appimage'
    // Packages installed by the updater stay in userData; the others go where the user finds them.
    const dir = auto ? join(updatesDir(), 'full') : process.env['MARKFLOW_DOWNLOAD_DIR'] || app.getPath('downloads')
    if (auto) await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    const dest = join(dir, basename(pkg.name || pkg.url))
    const partial = dest + '.download'
    this.fullReady = null
    this.set({ status: 'full-downloading', total: pkg.size, downloaded: 0, error: undefined })
    const res = await net.fetch(resolveUrl(pkg.url))
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const hash = createHash('sha512')
    const out = createWriteStream(partial)
    const reader = res.body.getReader()
    let downloaded = 0
    let lastEmit = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        if (!out.write(value)) await new Promise((r) => out.once('drain', r))
        downloaded += value.length
        if (Date.now() - lastEmit > 200) {
          lastEmit = Date.now()
          this.set({ downloaded })
        }
      }
    } finally {
      await new Promise((r) => out.end(r))
    }
    if (hash.digest('hex') !== pkg.sha512) {
      await fs.rm(partial, { force: true })
      throw new Error('Installer checksum mismatch')
    }
    await fs.rm(dest, { force: true })
    await fs.rename(partial, dest)

    let installPath = dest
    if (mode === 'mac-app') {
      // Unpack now so the swap after quitting is just two renames.
      const unpacked = join(dir, 'app')
      await run('/usr/bin/ditto', ['-x', '-k', dest, unpacked])
      const bundle = (await fs.readdir(unpacked)).find((n) => n.endsWith('.app'))
      if (!bundle || !existsSync(join(unpacked, bundle, 'Contents/Info.plist'))) throw new Error('The update package has no app')
      await fs.rm(dest, { force: true })
      installPath = join(unpacked, bundle)
    } else if (mode === 'appimage' || (process.platform === 'linux' && dest.endsWith('.AppImage'))) {
      await fs.chmod(dest, 0o755)
    }
    if (auto) this.fullReady = { mode, path: installPath }
    this.set({ status: 'full-ready', downloaded, installerPath: auto ? undefined : dest, autoInstall: auto })
  }

  /** Apply a downloaded update: restart into the hot version or the new package, or hand over the installer. */
  async install(): Promise<void> {
    if (this.state.status === 'ready') {
      this.relaunchOnQuit = true
      app.quit()
    } else if (this.state.status === 'full-ready' && this.fullReady) {
      // Installed from will-quit, once every window agreed to close (unsaved changes can cancel it).
      this.installOnQuit = true
      app.quit()
    } else if (this.state.status === 'full-ready' && this.state.installerPath) {
      const path = this.state.installerPath
      if (process.platform === 'linux' && !path.endsWith('.deb')) {
        shell.showItemInFolder(path)
        return
      }
      const err = await shell.openPath(path)
      if (err) this.set({ status: 'error', error: err })
      // The Windows installer replaces the running app; quit so it is not blocked.
      else if (process.platform === 'win32') setTimeout(() => app.quit(), 1500)
    }
  }

  /** Called from will-quit: relaunch into a hot update or start installing the full package. */
  applyOnQuit(): void {
    if (this.relaunchOnQuit) {
      app.relaunch()
      return
    }
    const full = this.fullReady
    if (!this.installOnQuit || !full) return
    try {
      if (full.mode === 'nsis') {
        // --updated keeps the install location and mode; --force-run starts the new version.
        spawn(full.path, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      } else if (full.mode === 'mac-app') {
        const bundle = macBundle()
        if (!bundle) throw new Error('The app folder is not writable')
        spawn('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'markflow-update', String(process.pid), bundle, full.path], {
          detached: true,
          stdio: 'ignore'
        }).unref()
      } else if (full.mode === 'appimage') {
        const target = appImagePath()
        if (!target) throw new Error('The AppImage folder is not writable')
        // Renaming over the running AppImage is safe: the mounted image keeps the old inode.
        const tmp = join(dirname(target), `.${basename(target)}.update`)
        copyFileSync(full.path, tmp)
        chmodSync(tmp, 0o755)
        renameSync(tmp, target)
        rmSync(full.path, { force: true })
        app.relaunch({ execPath: target, args: [] })
      }
    } catch (err) {
      console.error('[updater] could not install the update', err)
    }
  }

  cancelRelaunch(): void {
    this.relaunchOnQuit = false
    this.installOnQuit = false
  }

  /** Called once the UI is up: the running hot version booted fine; tidy old versions. */
  async confirmBoot(): Promise<void> {
    const hot = readHotState()
    const running = process.env['MARKFLOW_HOT'] === '1' ? appVersion() : null
    if (running && hot.booting?.version === running) {
      delete hot.booting
      writeHotState(hot)
    }
    try {
      const keep = new Set([hot.current?.dir, running].filter(Boolean) as string[])
      for (const name of await fs.readdir(updatesDir())) {
        if (name === 'state.json' || keep.has(name)) continue
        if (name.endsWith('.partial') && this.busy) continue
        if (name === 'full' && (this.busy || this.fullReady)) continue
        await fs.rm(join(updatesDir(), name), { recursive: true, force: true })
      }
    } catch {
      // updates dir may not exist yet
    }
  }
}

export const updater = new Updater()
