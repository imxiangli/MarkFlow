/**
 * Auto-updater with incremental (file-level) updates.
 *
 * Server layout (static hosting is enough, see scripts/release-update.mjs):
 *   <base>/latest.json          signed manifest (UpdateManifest)
 *   <base>/latest.json.sig      base64 Ed25519 signature of latest.json's exact bytes
 *   <base>/files/<sha256>.gz    content-addressed app files
 *   <base>/full/<ver>/<name>    full installers, only needed when the Electron runtime changes
 *
 * A hot update copies unchanged files from the running app and downloads only the rest,
 * then src/bootstrap picks the new version up on the next launch.
 */
import { app, net, shell } from 'electron'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createWriteStream, existsSync, promises as fs, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { markflow as packageConfig } from '../../package.json'
import { compareVersions, type UpdateManifest, type UpdateState } from '@shared/update'
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

function baseUrl(): string {
  const url =
    process.env['MARKFLOW_UPDATE_URL'] || getStore().settings.updateUrl.trim() || (packageConfig?.updateUrl ?? '')
  if (!url) return ''
  return url.endsWith('/') ? url : url + '/'
}

function resolveUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : baseUrl() + path.replace(/^\/+/, '')
}

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

  constructor() {
    this.state = {
      status: 'idle',
      currentVersion: appVersion(),
      baseVersion: process.env['MARKFLOW_BASE_VERSION'] || app.getVersion(),
      hot: process.env['MARKFLOW_HOT'] === '1'
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
      lastChecked: this.state.lastChecked
    }
    this.state = replace ? { ...base, status: 'idle', ...patch } : { ...this.state, ...patch }
    broadcast('mf:update-state', this.state)
    return this.state
  }

  private disabledReason(): string | null {
    if (!app.isPackaged && !process.env['MARKFLOW_FORCE_HOT']) return 'dev'
    if (!baseUrl()) return 'no-url'
    return null
  }

  start(): void {
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
      const info = { latestVersion: manifest.version, notes: notesText(manifest), lastChecked, fullSize: this.fullPackage()?.size }
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
   * latest.json is verified against the immutable versions/<version>.json.sig, which the
   * deploy script uploads before latest.json — so a half-finished upload or a CDN serving a
   * stale latest.json never pairs a manifest with the wrong signature.
   */
  private async fetchManifest(): Promise<UpdateManifest> {
    const base = baseUrl()
    const raw = Buffer.from(await (await fetchWithTimeout(`${base}latest.json?t=${Date.now()}`)).arrayBuffer())
    let claimed = ''
    try {
      claimed = String((JSON.parse(raw.toString('utf8')) as { version?: unknown }).version ?? '')
    } catch {
      throw new Error('latest.json is not valid JSON')
    }
    let sig: string
    try {
      if (!/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(claimed)) throw new Error('bad version')
      sig = await (await fetchWithTimeout(`${base}versions/${claimed}.json.sig`)).text()
    } catch {
      sig = await (await fetchWithTimeout(`${base}latest.json.sig?t=${Date.now()}`)).text()
    }
    return verifyManifest(raw, sig)
  }

  private canHotUpdate(m: UpdateManifest): boolean {
    if (m.electron !== process.versions.electron) return false
    if (m.bootstrapApi > bootstrapApi()) return false
    if (!m.files.length) return false
    return !readHotState().failed?.includes(m.version)
  }

  private fullPackage() {
    return this.manifest?.full?.[`${process.platform}-${process.arch}`]
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
        const gz = await fetchBuffer(resolveUrl(`files/${f.sha256}.gz`), (n) => {
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
    const pkg = this.fullPackage()
    if (!pkg) throw new Error(`No installer for ${process.platform}-${process.arch}`)
    const dest = join(process.env['MARKFLOW_DOWNLOAD_DIR'] || app.getPath('downloads'), basename(pkg.name || pkg.url))
    const partial = dest + '.download'
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
    if (process.platform === 'linux' && dest.endsWith('.AppImage')) await fs.chmod(dest, 0o755)
    this.set({ status: 'full-ready', downloaded, installerPath: dest })
  }

  /** Apply a downloaded update: restart into the hot version, or hand over to the installer. */
  async install(): Promise<void> {
    if (this.state.status === 'ready') {
      this.relaunchOnQuit = true
      app.quit()
    } else if (this.state.status === 'full-ready' && this.state.installerPath) {
      const path = this.state.installerPath
      if (process.platform === 'linux') {
        shell.showItemInFolder(path)
        return
      }
      const err = await shell.openPath(path)
      if (err) this.set({ status: 'error', error: err })
      // The Windows installer replaces the running app; quit so it is not blocked.
      else if (process.platform === 'win32') setTimeout(() => app.quit(), 1500)
    }
  }

  shouldRelaunch(): boolean {
    return this.relaunchOnQuit
  }

  cancelRelaunch(): void {
    this.relaunchOnQuit = false
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
        await fs.rm(join(updatesDir(), name), { recursive: true, force: true })
      }
    } catch {
      // updates dir may not exist yet
    }
  }
}

export const updater = new Updater()
