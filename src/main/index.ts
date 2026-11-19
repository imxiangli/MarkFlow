import { app, BrowserWindow, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStartupBackups } from './backups'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { registerAssetProtocol, registerSchemes } from './protocol'
import { getStore } from './store'
import { updater } from './updater'
import { contexts, createWindow, disposeWatchers, openPathsInApp, setQuitting } from './windows'

registerSchemes()
// Needed on Windows for jump lists / recent documents to group under the installed app.
if (process.platform === 'win32') app.setAppUserModelId('com.markflow.app')

// Files opened from Finder / the Dock (macOS) can arrive before the app is ready.
const queuedPaths: string[] = []
let appReady = false

app.on('will-finish-launching', () => {
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (appReady) void openPathsInApp([path])
    else queuedPaths.push(path)
  })
})

/** Extract file / folder paths from a command line (Windows & Linux file associations, CLI). */
function pathsFromArgv(argv: string[], cwd: string): string[] {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  const appPath = resolve(app.getAppPath())
  const out: string[] = []
  for (const raw of args) {
    if (!raw || raw.startsWith('-')) continue
    let p = raw
    if (p.startsWith('file://')) {
      try {
        p = fileURLToPath(p)
      } catch {
        continue
      }
    }
    const abs = resolve(cwd, p)
    // Skip the app itself (dev: `electron .` or `electron out/main/bootstrap.js`).
    if (abs === appPath || abs === resolve(process.execPath) || abs.startsWith(join(appPath, 'out') + sep)) continue
    if (existsSync(abs)) out.push(abs)
  }
  return out
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    void openPathsInApp(pathsFromArgv(argv, workingDirectory))
  })

  void app.whenReady().then(() => {
    const store = getStore()
    nativeTheme.themeSource = store.settings.theme
    registerAssetProtocol()
    loadStartupBackups()
    registerIpc()
    buildMenu()

    const initial = [...queuedPaths, ...pathsFromArgv(process.argv, process.cwd())]
    queuedPaths.length = 0
    appReady = true
    createWindow({ paths: initial, restoreSession: initial.length === 0 })
    updater.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow({})
    })
  })

  app.on('before-quit', () => {
    setQuitting(true)
    getStore().flush()
  })

  app.on('window-all-closed', () => {
    getStore().flush()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    for (const ctx of contexts.values()) disposeWatchers(ctx)
    updater.stop()
    // Restart into a freshly downloaded update, or start installing a full package.
    updater.applyOnQuit()
  })
}
