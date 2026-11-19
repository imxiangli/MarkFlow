import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, basename } from 'node:path'
import { ASSET_SCHEME, ENCODING_LABELS, MARKDOWN_EXTENSIONS, isBinaryFile } from '@shared/constants'
import type { FileData, LineEnding, MessageBoxOptions, ScanOptions, SearchOptions, SessionState, Settings, TextEncoding, WriteOptions } from '@shared/types'
import { claimStartupBackups, deleteBackups, stashBackups, writeBackup } from './backups'
import { setAsDefaultMarkdownApp } from './default-app'
import { mt, systemLocale } from './locale'
import { appVersion, updater } from './updater'
import { buildMenu } from './menu'
import { listHeadings, searchFolder } from './scanner'
import { getStore } from './store'
import { SNIFF_BYTES, decodeText, encodeText, looksBinary } from './textfile'
import {
  LARGE_FILE_SIZE,
  MAX_EDITOR_SIZE,
  abortLargeWrite,
  beginLargeWrite,
  closeLargeRead,
  endLargeWrite,
  openLargeRead,
  readLargeChunk,
  writeLargeChunk
} from './largefile'
import {
  broadcast,
  closeWorkspace,
  contexts,
  createWindow,
  getContext,
  markReady,
  openWorkspace,
  refreshWorkspace,
  setQuitting,
  setWatchedFiles,
  type WindowContext
} from './windows'


function ctxOf(e: IpcMainInvokeEvent | Electron.IpcMainEvent): WindowContext {
  const ctx = getContext(e.sender.id)
  if (!ctx) throw new Error('Unknown window')
  return ctx
}

function str(v: unknown, name = 'argument'): string {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${name}`)
  return v
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function markdownFilters() {
  return [
    { name: mt('dialog.markdown'), extensions: MARKDOWN_EXTENSIONS },
    { name: mt('dialog.allFiles'), extensions: ['*'] }
  ]
}

export function registerIpc(): void {
  const store = getStore()

  /* ---------------- app / window ---------------- */
  ipcMain.handle('mf:get-initial-state', (e) => {
    const ctx = ctxOf(e)
    const isFirstWindow = [...contexts.keys()][0] === ctx.id
    const session = ctx.restoreSession && store.settings.restoreSession ? store.session : null
    ctx.restoreSession = false
    return {
      settings: store.settings,
      recent: store.recent,
      session,
      locale: systemLocale(),
      platform: process.platform,
      version: appVersion(),
      homeDir: homedir(),
      isFirstWindow,
      isPackaged: app.isPackaged,
      backups: claimStartupBackups()
    }
  })

  ipcMain.on('mf:renderer-ready', (e) => {
    const ctx = getContext(e.sender.id)
    if (!ctx) return
    markReady(ctx)
    void updater.confirmBoot()
  })

  ipcMain.on('mf:close-window', (e) => {
    const ctx = getContext(e.sender.id)
    if (!ctx) return
    ctx.allowClose = true
    ctx.win.close()
  })

  ipcMain.on('mf:close-cancelled', () => {
    setQuitting(false)
    updater.cancelRelaunch()
  })
  ipcMain.on('mf:new-window', () => createWindow({}))

  ipcMain.on('mf:set-document-state', (e, state: { path: string | null; dirty: boolean; title: string }) => {
    const ctx = getContext(e.sender.id)
    if (!ctx || ctx.win.isDestroyed()) return
    ctx.win.setTitle(state.title || 'MarkFlow')
    if (process.platform === 'darwin') {
      ctx.win.setRepresentedFilename(state.path ?? '')
      ctx.win.setDocumentEdited(!!state.dirty)
    }
  })

  /* ---------------- dialogs ---------------- */
  ipcMain.handle('mf:show-open-file', async (e, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      defaultPath,
      properties: ['openFile', 'multiSelections'],
      filters: markdownFilters()
    })
    return res.canceled ? null : res.filePaths
  })

  ipcMain.handle('mf:show-open-folder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  ipcMain.handle(
    'mf:show-save-dialog',
    async (e, defaultPath: string, filters?: { name: string; extensions: string[] }[]) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const res = await dialog.showSaveDialog(win, {
        defaultPath,
        filters: filters ?? markdownFilters(),
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
      return res.canceled || !res.filePath ? null : res.filePath
    }
  )

  ipcMain.handle('mf:show-message-box', async (e, options: MessageBoxOptions) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showMessageBox(win, {
      type: options.type ?? 'question',
      title: options.title ?? 'MarkFlow',
      message: options.message,
      detail: options.detail,
      buttons: options.buttons,
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? options.buttons.length - 1,
      noLink: true
    })
    return res.response
  })

  /* ---------------- file system ---------------- */
  ipcMain.handle('mf:read-file', async (_e, path: unknown, encoding?: unknown): Promise<FileData> => {
    const p = str(path, 'path')
    const forced = typeof encoding === 'string' && encoding in ENCODING_LABELS ? (encoding as TextEncoding) : undefined
    const st = await fs.stat(p)
    if (!st.isFile()) throw new Error('Not a file')
    const binary = { binary: true as const, path: p, mtime: st.mtimeMs, size: st.size }
    // Known binary formats (videos, archives…) are never read.
    if (!forced && isBinaryFile(p)) return binary
    if (!forced) {
      const handle = await fs.open(p, 'r')
      try {
        const head = Buffer.alloc(Math.min(st.size, SNIFF_BYTES))
        await handle.read(head, 0, head.length, 0)
        if (looksBinary(head)) return binary
      } finally {
        await handle.close()
      }
    }
    // Large text is streamed by the renderer (largeOpen / largeRead) instead of sent in one piece.
    if (st.size > MAX_EDITOR_SIZE) return { ...binary, tooLarge: true }
    if (st.size > LARGE_FILE_SIZE) return { binary: false, large: true, path: p, mtime: st.mtimeMs, size: st.size }
    const { content, encoding: enc, eol } = decodeText(await fs.readFile(p), forced)
    return { binary: false, path: p, content, mtime: st.mtimeMs, size: st.size, encoding: enc, eol }
  })

  ipcMain.handle('mf:write-file', async (_e, path: unknown, content: unknown, options?: WriteOptions) => {
    const p = str(path, 'path')
    if (typeof content !== 'string') throw new Error('Invalid content')
    // Encode first: an EncodeError ("EENCODE:<encoding>") must not leave a truncated file behind.
    const data = encodeText(content, options?.encoding ?? 'utf8', options?.eol ?? 'lf')
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, data)
    const st = await fs.stat(p)
    return { mtime: st.mtimeMs }
  })

  ipcMain.handle('mf:large-open', (e, path: unknown, encoding?: unknown) =>
    openLargeRead(e.sender.id, str(path, 'path'), typeof encoding === 'string' && encoding in ENCODING_LABELS ? (encoding as TextEncoding) : undefined)
  )
  ipcMain.handle('mf:large-read', (_e, id: unknown) => readLargeChunk(str(id, 'id')))
  ipcMain.handle('mf:large-close', (_e, id: unknown) => closeLargeRead(str(id, 'id')))
  ipcMain.handle('mf:large-write-begin', (e, path: unknown, options?: { encoding?: TextEncoding; eol?: LineEnding }) =>
    beginLargeWrite(e.sender.id, str(path, 'path'), options?.encoding ?? 'utf8', options?.eol ?? 'lf')
  )
  ipcMain.handle('mf:large-write-chunk', (_e, id: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid content')
    return writeLargeChunk(str(id, 'id'), text)
  })
  ipcMain.handle('mf:large-write-end', (_e, id: unknown) => endLargeWrite(str(id, 'id')))
  ipcMain.handle('mf:large-write-abort', (_e, id: unknown) => abortLargeWrite(str(id, 'id')))

  ipcMain.handle('mf:file-icon', async (_e, path: unknown) => {
    const p = str(path, 'path')
    // The system thumbnail (Quick Look / Explorer) is a crisp, large file-type icon.
    if (process.platform !== 'linux') {
      try {
        const thumb = await nativeImage.createThumbnailFromPath(p, { width: 256, height: 256 })
        if (!thumb.isEmpty()) return thumb.toDataURL()
      } catch {
        // No thumbnail provider for this file: fall back to the plain icon.
      }
    }
    try {
      // 'large' is unsupported on macOS (and crashes Electron 44 there).
      const icon = await app.getFileIcon(p, { size: process.platform === 'darwin' ? 'normal' : 'large' })
      return icon.isEmpty() ? null : icon.toDataURL({ scaleFactor: 2 })
    } catch {
      return null
    }
  })

  ipcMain.handle('mf:stat', async (_e, path: unknown) => {
    try {
      const st = await fs.stat(str(path, 'path'))
      return { isFile: st.isFile(), isDirectory: st.isDirectory(), mtime: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  })

  ipcMain.handle('mf:create-file', async (_e, path: unknown, content?: string) => {
    const p = str(path, 'path')
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, content ?? '', { encoding: 'utf8', flag: 'wx' })
  })

  ipcMain.handle('mf:create-dir', async (_e, path: unknown) => {
    const p = str(path, 'path')
    if (await exists(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    await fs.mkdir(p, { recursive: true })
  })

  ipcMain.handle('mf:rename', async (_e, oldPath: unknown, newPath: unknown) => {
    const from = str(oldPath, 'path')
    const to = str(newPath, 'path')
    const caseOnly = from.toLowerCase() === to.toLowerCase() && from !== to
    if (!caseOnly && (await exists(to))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    await fs.rename(from, to)
  })

  ipcMain.handle('mf:trash', async (_e, path: unknown) => {
    await shell.trashItem(str(path, 'path'))
  })

  ipcMain.handle('mf:save-image', async (_e, dir: unknown, fileName: unknown, data: unknown) => {
    const d = str(dir, 'dir')
    const name = basename(str(fileName, 'fileName')).replace(/[\\/:*?"<>|]/g, '-')
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Invalid data')
    await fs.mkdir(d, { recursive: true })
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let target = join(d, name)
    for (let i = 1; await exists(target); i++) target = join(d, `${stem}-${i}${ext}`)
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from((data as Uint8Array).buffer)
    await fs.writeFile(target, buf)
    return target
  })

  ipcMain.handle('mf:copy-file', async (_e, src: unknown, dest: unknown) => {
    const to = str(dest, 'dest')
    await fs.mkdir(dirname(to), { recursive: true })
    await fs.copyFile(str(src, 'src'), to)
  })

  /* ---------------- workspace ---------------- */
  ipcMain.handle('mf:open-workspace', async (e, root: unknown, options: ScanOptions) => {
    const ctx = ctxOf(e)
    const r = str(root, 'root')
    const st = await fs.stat(r)
    if (!st.isDirectory()) throw new Error('Not a directory')
    const tree = await openWorkspace(ctx, r, options)
    app.addRecentDocument(r)
    broadcast('mf:recent-changed', store.addRecent(r, 'folder'))
    buildMenu()
    return tree
  })

  ipcMain.handle('mf:refresh-workspace', (e, options: ScanOptions) => refreshWorkspace(ctxOf(e), options))

  ipcMain.handle('mf:close-workspace', (e) => closeWorkspace(ctxOf(e)))

  ipcMain.on('mf:watch-files', (e, paths: unknown) => {
    const ctx = getContext(e.sender.id)
    if (!ctx || !Array.isArray(paths)) return
    setWatchedFiles(
      ctx,
      paths.filter((p): p is string => typeof p === 'string')
    )
  })

  ipcMain.handle(
    'mf:search',
    (_e, root: unknown, query: unknown, options: SearchOptions & ScanOptions) =>
      searchFolder(str(root, 'root'), typeof query === 'string' ? query : '', options)
  )

  ipcMain.handle('mf:list-headings', (_e, root: unknown, options: ScanOptions) =>
    listHeadings(str(root, 'root'), options ?? { showAllFiles: false, showHiddenFiles: false })
  )

  /* ---------------- shell ---------------- */
  ipcMain.handle('mf:open-external', async (_e, url: unknown) => {
    const u = str(url, 'url')
    if (!/^(https?|mailto):/i.test(u)) throw new Error('Blocked URL scheme')
    await shell.openExternal(u)
  })
  ipcMain.on('mf:show-item-in-folder', (_e, path: unknown) => {
    if (typeof path === 'string') shell.showItemInFolder(path)
  })
  ipcMain.handle('mf:open-path', (_e, path: unknown) => shell.openPath(str(path, 'path')))
  ipcMain.on('mf:copy-text', (_e, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.handle('mf:read-clipboard', () => clipboard.readText())
  ipcMain.on('mf:edit-action', (e, action: unknown) => {
    if (action === 'cut') e.sender.cut()
    else if (action === 'copy') e.sender.copy()
    else if (action === 'paste') e.sender.paste()
  })
  ipcMain.handle('mf:copy-image', async (_e, src: unknown) => {
    const url = str(src, 'src')
    let image: Electron.NativeImage
    if (url.startsWith('data:')) image = nativeImage.createFromDataURL(url)
    else {
      if (!/^https?:/i.test(url) && !url.startsWith(`${ASSET_SCHEME}:`)) throw new Error('Blocked URL scheme')
      const res = await net.fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
    }
    if (image.isEmpty()) throw new Error('Unsupported image')
    clipboard.writeImage(image)
  })
  ipcMain.on('mf:set-fullscreen', (e, flag: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) win.setFullScreen(!!flag)
  })

  /* ---------------- settings / recent / session ---------------- */
  ipcMain.handle('mf:set-settings', (_e, partial: Partial<Settings>) => {
    const before = store.settings
    const next = store.setSettings(partial ?? {})
    if (before.theme !== next.theme) nativeTheme.themeSource = next.theme
    if (before.language !== next.language || before.theme !== next.theme) buildMenu()
    if (before.updateUrl !== next.updateUrl) void updater.check(false)
    broadcast('mf:settings-changed', next)
    return next
  })

  ipcMain.on('mf:add-recent', (_e, path: unknown, kind: unknown) => {
    if (typeof path !== 'string' || (kind !== 'file' && kind !== 'folder')) return
    app.addRecentDocument(path)
    broadcast('mf:recent-changed', store.addRecent(path, kind))
    buildMenu()
  })

  ipcMain.on('mf:clear-recent', () => {
    app.clearRecentDocuments()
    broadcast('mf:recent-changed', store.clearRecent())
    buildMenu()
  })

  ipcMain.on('mf:set-session', (_e, session: SessionState) => {
    if (session && typeof session === 'object') store.setSession(session)
  })

  /* ---------------- export / print ---------------- */
  ipcMain.handle('mf:export-pdf', async (e, defaultPath: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showSaveDialog(win, {
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      filters: [{ name: mt('dialog.pdf'), extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (res.canceled || !res.filePath) return null
    const data = await e.sender.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      generateDocumentOutline: true
    })
    await fs.writeFile(res.filePath, data)
    return res.filePath
  })

  ipcMain.handle(
    'mf:print',
    (e) =>
      new Promise<boolean>((resolve) => {
        e.sender.print({ printBackground: true }, (success) => resolve(success))
      })
  )

  ipcMain.handle('mf:set-default-app', () => setAsDefaultMarkdownApp())

  /* ---------------- crash recovery ---------------- */
  ipcMain.handle('mf:backup-write', (_e, entry) => writeBackup(entry))
  ipcMain.handle('mf:backup-delete', (_e, ids: unknown) => deleteBackups(Array.isArray(ids) ? ids : []))
  ipcMain.handle('mf:backup-stash', (_e, ids: unknown) => stashBackups(Array.isArray(ids) ? ids : []))

  /* ---------------- updates ---------------- */
  ipcMain.handle('mf:update-state', () => updater.getState())
  ipcMain.handle('mf:update-check', () => updater.check(true))
  ipcMain.handle('mf:update-download', () => updater.download())
  ipcMain.handle('mf:update-install', () => updater.install())
}
