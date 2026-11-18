/**
 * Application entry point ("shell").
 *
 * The packaged app ships the Electron runtime plus a baseline copy of the app code in
 * app.asar. Incremental updates only download changed app files into
 * <userData>/updates/<version>/; this loader decides at startup which copy to run.
 *
 * This file is the one piece of JS that is never hot-updated, so it must stay small,
 * dependency-free and backwards compatible. Bump BOOTSTRAP_API when the contract with the
 * app code changes; the updater refuses hot updates that need a newer bootstrap.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BOOTSTRAP_API = 1
/** A hot version that fails to finish starting this many times in a row is abandoned. */
const MAX_BOOT_ATTEMPTS = 2

interface HotState {
  current?: { version: string; dir: string; electron: string; bootstrapApi: number }
  failed?: string[]
  booting?: { version: string; attempts: number }
}

// Allows isolated profiles (used by the end-to-end tests). Must run before userData is read.
if (process.env['MARKFLOW_USER_DATA']) app.setPath('userData', process.env['MARKFLOW_USER_DATA'])

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

const updatesDir = join(app.getPath('userData'), 'updates')
const statePath = join(updatesDir, 'state.json')

function readState(): HotState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as HotState
  } catch {
    return {}
  }
}

function writeState(state: HotState): void {
  try {
    mkdirSync(updatesDir, { recursive: true })
    writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2))
    renameSync(statePath + '.tmp', statePath)
  } catch {
    // Never block startup on bookkeeping.
  }
}

function markFailed(state: HotState, version: string): void {
  state.failed = [...new Set([...(state.failed ?? []), version])]
  delete state.booting
  writeState(state)
}

/** Returns the hot update to run, or null to run the bundled code. */
function pickHotVersion(state: HotState): { version: string; entry: string; root: string } | null {
  if (!app.isPackaged && !process.env['MARKFLOW_FORCE_HOT']) return null
  const c = state.current
  if (!c) return null
  if (c.electron !== process.versions.electron) return null
  if (c.bootstrapApi > BOOTSTRAP_API) return null
  // A newer full install supersedes any older hot update.
  if (compareVersions(c.version, app.getVersion()) <= 0) return null
  if (state.failed?.includes(c.version)) return null
  const root = join(updatesDir, c.dir)
  const entry = join(root, 'out', 'main', 'index.js')
  if (!existsSync(entry)) return null
  const attempts = state.booting?.version === c.version ? state.booting.attempts + 1 : 1
  if (attempts > MAX_BOOT_ATTEMPTS) {
    markFailed(state, c.version)
    return null
  }
  state.booting = { version: c.version, attempts }
  writeState(state)
  return { version: c.version, entry, root }
}

function runBundled(): void {
  process.env['MARKFLOW_APP_VERSION'] = app.getVersion()
  process.env['MARKFLOW_APP_ROOT'] = app.getAppPath()
  process.env['MARKFLOW_HOT'] = '0'
  require(join(__dirname, 'index.js'))
}

process.env['MARKFLOW_BOOTSTRAP_API'] = String(BOOTSTRAP_API)
process.env['MARKFLOW_BASE_VERSION'] = app.getVersion()

const state = readState()
const hot = pickHotVersion(state)
if (hot) {
  process.env['MARKFLOW_APP_VERSION'] = hot.version
  process.env['MARKFLOW_APP_ROOT'] = hot.root
  process.env['MARKFLOW_HOT'] = '1'
  try {
    require(hot.entry)
  } catch (err) {
    // The update cannot even load: remember that and fall back to the bundled code.
    console.error('[bootstrap] hot update failed to load, falling back', err)
    markFailed(state, hot.version)
    runBundled()
  }
} else {
  runBundled()
}
