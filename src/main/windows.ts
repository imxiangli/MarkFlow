import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { isMarkdownFile } from '@shared/constants'
import type { FileChangeKind, MenuCommand, ScanOptions, TreeNode } from '@shared/types'
import { getStore } from './store'
import { isIgnoredName, scanFolder } from './scanner'
import { attachChords } from './chords'
import { watchTree, type TreeChange, type TreeWatcher } from './treeWatcher'
import { disposeLargeSessions } from './largefile'

export interface WindowContext {
  id: number
  win: BrowserWindow
  root: string | null
  scanOptions: ScanOptions
  /** The workspace folder (one native handle on macOS / Windows). */
  watcher: TreeWatcher | null
  /** Paths shown in the current tree (normalised), to tell new / removed entries from edits. */
  treePaths: Set<string>
  /** Open files the workspace watcher doesn't cover (outside the folder, or hidden in it). */
  extraWatcher: FSWatcher | null
  watchedFiles: Set<string>
  ready: boolean
  pendingPaths: string[]
  restoreSession: boolean
  allowClose: boolean
  treeTimer: NodeJS.Timeout | null
}

export const contexts = new Map<number, WindowContext>()
let lastFocusedId: number | null = null
let quitting = false

export function setQuitting(value: boolean): void {
  quitting = value
}

export function isQuitting(): boolean {
  return quitting
}

const isMac = process.platform === 'darwin'
const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'

export function normPath(p: string): string {
  const r = resolve(p)
  return caseInsensitiveFs ? r.toLowerCase() : r
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b)
}

/** Key for tree lookups; FSEvents may report names decomposed (NFD). */
function treeKey(p: string): string {
  return normPath(p).normalize('NFC')
}

function collectTreePaths(node: TreeNode | null, out = new Set<string>()): Set<string> {
  if (!node) return out
  out.add(treeKey(node.path))
  node.children?.forEach((c) => collectTreePaths(c, out))
  return out
}

function isInside(child: string, parent: string): boolean {
  const c = normPath(child)
  const p = normPath(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export function getContext(webContentsId: number): WindowContext | undefined {
  return contexts.get(webContentsId)
}

export function getTargetContext(): WindowContext | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    const ctx = contexts.get(focused.webContents.id)
    if (ctx) return ctx
  }
  if (lastFocusedId !== null && contexts.has(lastFocusedId)) return contexts.get(lastFocusedId)
  return contexts.values().next().value
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const ctx of contexts.values()) {
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send(channel, ...args)
  }
}

export function sendCommand(cmd: MenuCommand, arg?: unknown): void {
  const ctx = getTargetContext()
  if (!ctx) {
    if (cmd === 'new-file' || cmd === 'open-file' || cmd === 'open-folder' || cmd === 'markdown-guide') {
      const created = createWindow({})
      created.win.webContents.once('did-finish-load', () => {
        setTimeout(() => created.win.webContents.send('mf:menu-command', cmd, arg), 300)
      })
    }
    return
  }
  ctx.win.webContents.send('mf:menu-command', cmd, arg)
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function deliverPaths(ctx: WindowContext, paths: string[]): void {
  if (!paths.length) return
  if (ctx.ready) ctx.win.webContents.send('mf:open-paths', paths)
  else ctx.pendingPaths.push(...paths)
  focusWindow(ctx.win)
}

/** Route files / folders opened from the OS (file association, CLI, dock) to a window. */
export async function openPathsInApp(paths: string[]): Promise<void> {
  const files: string[] = []
  const folders: string[] = []
  for (const p of paths) {
    try {
      const st = await fs.stat(p)
      if (st.isDirectory()) folders.push(p)
      else if (st.isFile()) files.push(p)
    } catch {
      // ignore missing paths
    }
  }
  for (const folder of folders) {
    const existing = [...contexts.values()].find((c) => c.root && samePath(c.root, folder))
    if (existing) {
      focusWindow(existing.win)
      continue
    }
    const target = getTargetContext()
    if (target && !target.root) {
      target.root = folder
      deliverPaths(target, [folder])
    } else {
      createWindow({ paths: [folder] })
    }
  }
  if (files.length) {
    // Prefer a window whose workspace contains the file.
    const owner = [...contexts.values()].find((c) => c.root && files.every((f) => isInside(f, c.root!)))
    const target = owner ?? getTargetContext()
    if (target) deliverPaths(target, files)
    else createWindow({ paths: files })
  }
  if (!folders.length && !files.length) {
    const target = getTargetContext()
    if (target) focusWindow(target.win)
    else createWindow({})
  }
}

function visibleBounds(b: { x?: number; y?: number; width: number; height: number }) {
  if (b.x === undefined || b.y === undefined) return { width: b.width, height: b.height }
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x! + 80 > a.x && b.y! + 40 > a.y && b.x! < a.x + a.width - 80 && b.y! < a.y + a.height - 40
  })
  return ok ? b : { width: b.width, height: b.height }
}

export function createWindow(opts: { paths?: string[]; restoreSession?: boolean }): WindowContext {
  const store = getStore()
  const ws = store.windowState
  let bounds: { x?: number; y?: number; width: number; height: number } = {
    x: ws.x,
    y: ws.y,
    width: ws.width,
    height: ws.height
  }
  const ref = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (ref) {
    const b = ref.getBounds()
    bounds = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height }
  }

  const win = new BrowserWindow({
    ...visibleBounds(bounds),
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'MarkFlow',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    autoHideMenuBar: false,
    icon: process.platform === 'linux' ? join(__dirname, '../../resources/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false
    }
  })

  const ctx: WindowContext = {
    id: win.webContents.id,
    win,
    root: null,
    scanOptions: { showAllFiles: store.settings.showAllFiles, showHiddenFiles: store.settings.showHiddenFiles },
    watcher: null,
    treePaths: new Set(),
    extraWatcher: null,
    watchedFiles: new Set(),
    ready: false,
    pendingPaths: [...(opts.paths ?? [])],
    restoreSession: !!opts.restoreSession,
    allowClose: false,
    treeTimer: null
  }
  contexts.set(ctx.id, ctx)

  if (!ref && ws.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.on('focus', () => {
    lastFocusedId = ctx.id
  })

  let boundsTimer: NodeJS.Timeout | null = null
  const saveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const maximized = win.isMaximized()
      const b = maximized ? store.windowState : win.getBounds()
      store.setWindowState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized })
    }, 400)
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)

  const wc = win.webContents
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (url === wc.getURL()) return
    e.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  wc.on('render-process-gone', () => {
    ctx.ready = false
    void disposeLargeSessions(ctx.id)
  })
  attachChords(wc)
  win.on('enter-full-screen', () => wc.send('mf:fullscreen', true))
  win.on('leave-full-screen', () => wc.send('mf:fullscreen', false))

  win.on('close', (e) => {
    if (ctx.allowClose) return
    if (!ctx.ready || wc.isCrashed()) return
    e.preventDefault()
    wc.send('mf:before-close')
  })
  win.on('closed', () => {
    disposeWatchers(ctx)
    void disposeLargeSessions(ctx.id)
    contexts.delete(ctx.id)
    if (lastFocusedId === ctx.id) lastFocusedId = null
    // Continue a pending quit: the next window (if any) gets asked about unsaved changes.
    if (quitting) app.quit()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return ctx
}

export function markReady(ctx: WindowContext): void {
  ctx.ready = true
  if (ctx.pendingPaths.length) {
    const paths = ctx.pendingPaths
    ctx.pendingPaths = []
    ctx.win.webContents.send('mf:open-paths', paths)
  }
}

/* ------------------------------------------------------------------ */
/* Workspace watching                                                  */
/* ------------------------------------------------------------------ */

export function disposeWatchers(ctx: WindowContext): void {
  if (ctx.treeTimer) clearTimeout(ctx.treeTimer)
  ctx.treeTimer = null
  ctx.watcher?.close()
  void ctx.extraWatcher?.close()
  ctx.watcher = null
  ctx.extraWatcher = null
}

function notifyFile(ctx: WindowContext, path: string, kind: FileChangeKind): void {
  if (ctx.win.isDestroyed()) return
  for (const watched of ctx.watchedFiles) {
    if (samePath(watched, path)) {
      ctx.win.webContents.send('mf:file-changed', watched, kind)
      return
    }
  }
}

function scheduleTreeRefresh(ctx: WindowContext): void {
  if (ctx.treeTimer) clearTimeout(ctx.treeTimer)
  ctx.treeTimer = setTimeout(async () => {
    ctx.treeTimer = null
    if (!ctx.root || ctx.win.isDestroyed()) return
    const tree = await scanFolder(ctx.root, ctx.scanOptions)
    ctx.treePaths = collectTreePaths(tree)
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send('mf:tree-changed', tree)
  }, 250)
}

/**
 * A path in the workspace changed. Open documents are told about it; the tree is rescanned
 * only when an entry it shows disappears or one it would show appears (not on every save).
 */
function onTreeChange(ctx: WindowContext, change: TreeChange): void {
  notifyFile(ctx, change.path, change.exists ? 'change' : 'unlink')
  const inTree = ctx.treePaths.has(treeKey(change.path))
  if (change.exists) {
    const shown = ctx.scanOptions.showAllFiles || (!change.isDir && isMarkdownFile(change.path))
    if (!inTree && shown) scheduleTreeRefresh(ctx)
  } else if (inTree) {
    scheduleTreeRefresh(ctx)
  }
}

/** chokidar events for the few open files outside the workspace watcher. */
function attachFileEvents(ctx: WindowContext, w: FSWatcher): void {
  w.on('all', (event, path) => {
    if (event === 'change' || event === 'add') notifyFile(ctx, path, 'change')
    else if (event === 'unlink') notifyFile(ctx, path, 'unlink')
  })
  w.on('error', (err) => console.warn('[watcher]', err))
}

const watchOptions = {
  ignoreInitial: true,
  ignorePermissionErrors: true,
  awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 }
}

export async function openWorkspace(ctx: WindowContext, root: string, options: ScanOptions) {
  disposeWatchers(ctx)
  ctx.root = root
  ctx.scanOptions = options
  const tree = await scanFolder(root, options)
  ctx.treePaths = collectTreePaths(tree)
  ctx.watcher = watchTree(resolve(root), {
    ignoreName: (name) => isIgnoredName(name, ctx.scanOptions),
    onChange: (change) => onTreeChange(ctx, change),
    onRescan: () => scheduleTreeRefresh(ctx)
  })
  updateExtraWatcher(ctx)
  return tree
}

export async function refreshWorkspace(ctx: WindowContext, options: ScanOptions) {
  if (!ctx.root) return null
  const hiddenChanged = options.showHiddenFiles !== ctx.scanOptions.showHiddenFiles
  if (hiddenChanged) return openWorkspace(ctx, ctx.root, options)
  ctx.scanOptions = options
  const tree = await scanFolder(ctx.root, options)
  ctx.treePaths = collectTreePaths(tree)
  return tree
}

export function closeWorkspace(ctx: WindowContext): void {
  ctx.watcher?.close()
  ctx.watcher = null
  ctx.treePaths = new Set()
  ctx.root = null
  updateExtraWatcher(ctx)
}

export function setWatchedFiles(ctx: WindowContext, paths: string[]): void {
  ctx.watchedFiles = new Set(paths)
  updateExtraWatcher(ctx)
}

/** Open files inside the workspace that its watcher skips (hidden files, node_modules…). */
function skippedByWorkspace(ctx: WindowContext, p: string): boolean {
  if (!ctx.root || !ctx.watcher || !isInside(p, ctx.root)) return true
  return relative(ctx.root, p)
    .split(/[\\/]/)
    .some((segment) => segment !== '' && isIgnoredName(segment, ctx.scanOptions))
}

function updateExtraWatcher(ctx: WindowContext): void {
  void ctx.extraWatcher?.close()
  ctx.extraWatcher = null
  const outside = [...ctx.watchedFiles].filter((p) => skippedByWorkspace(ctx, p))
  if (!outside.length) return
  ctx.extraWatcher = watch(outside, watchOptions)
  attachFileEvents(ctx, ctx.extraWatcher)
}
