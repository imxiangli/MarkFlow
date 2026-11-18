import { resolveLocale } from '@shared/i18n'
import { COMMAND_MAP } from '@shared/keybindings'
import { ENCODING_LABELS, extOf, isBinaryFile, isImageFile, isMarkdownFile } from '@shared/constants'
import type { BackupEntry, FileData, LineEnding, MenuCommand, ScanOptions, Settings, TextEncoding, TreeNode, ViewMode } from '@shared/types'
import { EditorView } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import { editorBridge } from '@/editor/bridge'
import type { FormatCommand } from '@/editor/commands'
import { editorCommand } from '@/editor/keymap'
import { MARKDOWN_TYPE, documentType, languageAfterSave, nameForType } from '@/editor/languages'
import { detectContentType } from '@/editor/contentType'
import { bookmarkLines, gotoBookmark, openReplace, toggleBookmark, toggleSearchOption, seedFindFromSelection } from '@/editor/sublime'
import { jumpBack, jumpForward, recordJump, setLocationProvider, type NavLocation } from '@/lib/navHistory'
import { previewTopLine } from '@/lib/scrollSync'
import { largeDocs, loadLargeDoc, saveLargeDoc } from '@/lib/largeFile'
import { canStash, discardBackups, settleBackups, stashBackups } from '@/lib/backup'
import { hashString } from '@/lib/hash'
import { t } from '@/lib/i18n'
import { basename, dirname, fileUrlToPath, isInside, join, resolve, samePath } from '@/lib/path'
import { slugify } from '@/markdown/md'
import guideZh from '../../../docs/markdown-guide.zh-CN.md?raw'
import guideEn from '../../../docs/markdown-guide.en.md?raw'
import {
  activeTab,
  getState,
  isDirty,
  isEditable,
  isNewDocument,
  setState,
  toast,
  updateTab,
  useStore,
  type Tab,
  type TabKind
} from '@/store'

const api = window.mf

let tabSeq = 0
const newId = (): string => `t${++tabSeq}`

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** Kind by file name; 'text' is provisional until the content is sniffed (it may be binary). */
export function kindForPath(path: string): TabKind {
  if (isMarkdownFile(path)) return 'markdown'
  if (isImageFile(path)) return 'image'
  if (isBinaryFile(path)) return 'binary'
  return 'text'
}

/** Tab fields that come from reading a file. */
function fromFile(data: FileData): Partial<Tab> {
  if (data.binary) return { mtime: data.mtime, size: data.size, tooLarge: data.tooLarge }
  // Large text streams in afterwards (startLargeLoad); the store never holds a copy of it.
  if ('large' in data) return { mtime: data.mtime, size: data.size, large: true, content: '', saved: '', dirty: false }
  return {
    content: data.content,
    saved: data.content,
    mtime: data.mtime,
    size: data.size,
    encoding: data.encoding,
    eol: data.eol,
    savedEol: data.eol
  }
}

function scanOptions(settings: Settings = getState().settings): ScanOptions {
  return { showAllFiles: settings.showAllFiles, showHiddenFiles: settings.showHiddenFiles }
}

export function syncWatchedFiles(): void {
  const paths = getState()
    .tabs.map((t) => t.path)
    .filter((p): p is string => !!p)
  api.watchFiles(paths)
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

export interface OpenOptions {
  line?: number
  column?: number
  length?: number
  anchor?: string
}

let revealSeq = 0
export function requestReveal(tabId: string, opts: OpenOptions): void {
  if (opts.line === undefined && !opts.anchor) return
  if (getState().activeId === tabId) recordJump()
  setState({ reveal: { tabId, line: opts.line, anchor: opts.anchor, seq: ++revealSeq, ...opts } })
}

export function activate(id: string): void {
  if (getState().activeId === id) return
  recordJump()
  setState({ activeId: id })
}

function insertTab(tab: Tab): void {
  const s = getState()
  const active = activeTab(s)
  const replaceable =
    active && !active.path && !active.builtin && active.content === '' && active.saved === '' ? active : null
  let tabs: Tab[]
  if (replaceable) {
    tabs = s.tabs.map((x) => (x.id === replaceable.id ? tab : x))
    editorBridge.drop(replaceable.id)
  } else {
    const idx = active ? s.tabs.indexOf(active) : s.tabs.length - 1
    tabs = [...s.tabs.slice(0, idx + 1), tab, ...s.tabs.slice(idx + 1)]
  }
  if (!replaceable) recordJump()
  setState({ tabs, activeId: tab.id })
}

export async function openFile(path: string, opts: OpenOptions = {}): Promise<Tab | null> {
  const existing = getState().tabs.find((x) => samePath(x.path, path))
  if (existing) {
    activate(existing.id)
    requestReveal(existing.id, opts)
    return existing
  }
  let kind = kindForPath(path)
  let data: FileData | null = null
  if (kind !== 'image') {
    try {
      data = await api.readFile(path)
    } catch (e) {
      toast(t('toast.openFailed', { msg: errMsg(e) }), 'error')
      return null
    }
    // Any file opens: text in the editor (whatever its extension), everything else in the binary view.
    kind = data.binary ? 'binary' : kind === 'binary' ? 'text' : kind
  }
  // It may have been opened while we were reading.
  const again = getState().tabs.find((x) => samePath(x.path, path))
  if (again) {
    activate(again.id)
    return again
  }
  const tab: Tab = {
    id: newId(),
    path,
    name: basename(path),
    kind,
    content: '',
    saved: '',
    mtime: 0,
    externalChange: false,
    deleted: false,
    ...(data ? fromFile(data) : {})
  }
  insertTab(tab)
  if (tab.large) void startLargeLoad(tab.id, path)
  api.addRecent(path, 'file')
  syncWatchedFiles()
  const s = getState()
  if (!s.root && s.settings.openParentFolder) void openFolder(dirname(path), { quiet: true })
  requestReveal(tab.id, opts)
  return tab
}

/* ------------------------------------------------------------------ */
/* Large files                                                         */
/* ------------------------------------------------------------------ */

/** Large tabs being written: their own save shows up as a file change and must be ignored. */
const savingLarge = new Set<string>()

/**
 * Stream a large file into its tab (first open, reload, reopen with another encoding). The tab
 * shows a progress view meanwhile; closing it cancels the load.
 */
async function startLargeLoad(tabId: string, path: string, encoding?: TextEncoding): Promise<boolean> {
  updateTab(tabId, { loading: 0 })
  const alive = () => getState().tabs.some((x) => x.id === tabId)
  try {
    const result = await loadLargeDoc(path, encoding, (loading) => alive() && updateTab(tabId, { loading }), alive)
    if (!result || !alive()) return false
    largeDocs.set(tabId, result.doc)
    updateTab(tabId, {
      loading: undefined,
      encoding: result.encoding,
      eol: result.eol,
      savedEol: result.eol,
      dirty: false,
      externalChange: false
    })
    const tab = getState().tabs.find((x) => x.id === tabId)
    if (tab) editorBridge.resetTab(tab)
    return true
  } catch (e) {
    toast(t('toast.openFailed', { msg: errMsg(e) }), 'error')
    if (alive()) {
      // Nothing usable was loaded on a first open; a failed reload keeps the old text.
      if (editorBridge.getDoc(tabId) || largeDocs.has(tabId)) updateTab(tabId, { loading: undefined })
      else void closeTab(tabId, true)
    }
    return false
  }
}

export async function openFolder(root: string, opts: { quiet?: boolean } = {}): Promise<void> {
  try {
    const tree = await api.openWorkspace(root, scanOptions())
    setState((s) => ({
      root,
      tree,
      expanded: { [root]: true },
      sidebarVisible: opts.quiet ? s.sidebarVisible : true,
      sidebarPanel: opts.quiet ? s.sidebarPanel : 'files'
    }))
    syncWatchedFiles()
  } catch (e) {
    toast(t('toast.openFailed', { msg: errMsg(e) }), 'error')
  }
}

export async function closeFolder(): Promise<void> {
  await api.closeWorkspace()
  setState({ root: null, tree: null, expanded: {} })
  syncWatchedFiles()
}

export async function openPaths(paths: string[]): Promise<void> {
  const folders: string[] = []
  const files: string[] = []
  for (const p of paths) {
    const st = await api.stat(p)
    if (!st) toast(t('toast.openFailed', { msg: p }), 'error')
    else if (st.isDirectory) folders.push(p)
    else files.push(p)
  }
  // Open the folder first so files inside it show up highlighted in the tree.
  if (folders.length) await openFolder(folders[0])
  for (const f of files) await openFile(f)
}

export async function showOpenFile(): Promise<void> {
  const s = getState()
  const paths = await api.showOpenFile(s.root ?? undefined)
  if (paths) for (const p of paths) await openFile(p)
}

export async function showOpenFolder(): Promise<void> {
  const p = await api.showOpenFolder()
  if (p) await openFolder(p)
}

let untitledSeq = 0
export function newUntitled(
  content = '',
  name?: string,
  builtin = false,
  type: Pick<Tab, 'kind' | 'language' | 'autoType'> = { kind: 'markdown' }
): Tab {
  // Keep numbering past restored "Untitled-N" documents, whatever their type.
  const n = name ? /-(\d+)(?:\.[^.]*)?$/.exec(name) : null
  if (n) untitledSeq = Math.max(untitledSeq, Number(n[1]))
  const tab: Tab = {
    id: newId(),
    path: null,
    name: name ?? `${t('common.untitled')}-${++untitledSeq}.md`,
    ...type,
    content,
    saved: builtin ? content : '',
    mtime: 0,
    externalChange: false,
    deleted: false,
    builtin
  }
  insertTab(tab)
  return tab
}

export function newFile(): void {
  // Starts as Markdown, but its type follows what's typed or pasted until one is chosen.
  newUntitled('', undefined, false, { kind: 'markdown', autoType: true })
  const s = getState()
  if (s.viewMode === 'preview') setViewMode(s.lastEditMode)
  setTimeout(() => editorBridge.focus(), 50)
}

export function openGuide(): void {
  const locale = getState().locale
  const name = `${t('guide.title')}.md`
  const existing = getState().tabs.find((x) => x.builtin && x.name === name)
  if (existing) {
    activate(existing.id)
    return
  }
  newUntitled(locale === 'zh-CN' ? guideZh : guideEn, name, true)
}

/* ------------------------------------------------------------------ */
/* Saving / closing                                                    */
/* ------------------------------------------------------------------ */

export function updateContent(id: string, content: string): void {
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab || tab.content === content) return
  updateTab(id, { content })
  scheduleAutoSave(id)
  if (tab.autoType) scheduleTypeDetection(id)
}

const autoSaveTimers = new Map<string, number>()
function scheduleAutoSave(id: string): void {
  const s = getState()
  if (!s.settings.autoSave) return
  const tab = s.tabs.find((x) => x.id === id)
  if (!tab?.path) return
  clearTimeout(autoSaveTimers.get(id))
  autoSaveTimers.set(
    id,
    window.setTimeout(() => {
      autoSaveTimers.delete(id)
      const cur = getState().tabs.find((x) => x.id === id)
      if (cur && isDirty(cur) && !cur.externalChange) void saveTab(id, { quiet: true })
    }, 1000)
  )
}

export async function saveTab(id: string, opts: { saveAs?: boolean; quiet?: boolean; encoding?: TextEncoding } = {}): Promise<boolean> {
  flushPendingEdits()
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab || !isEditable(tab) || tab.loading !== undefined) return false
  // Large files are written line by line from the editor's document, never as one string.
  const doc = tab.large ? (editorBridge.getDoc(id) ?? largeDocs.get(id) ?? null) : null
  if (tab.large && !doc) return false
  const content = tab.large ? '' : (editorBridge.getContent(id) ?? tab.content)
  let path = tab.path
  if (!path || opts.saveAs) {
    const s = getState()
    const base = path ? dirname(path) : (s.root ?? s.homeDir)
    // Code / text files: offer their own extension, so Windows doesn't append ".md".
    const ext = tab.kind === 'text' ? extOf(tab.name) : ''
    const filters =
      tab.kind === 'text'
        ? [...(ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : []), { name: t('dialog.allFiles'), extensions: ['*'] }]
        : undefined
    const chosen = await api.showSaveDialog(join(base, tab.name), filters)
    if (!chosen) return false
    path = chosen
  }
  let encoding = opts.encoding ?? tab.encoding ?? 'utf8'
  const eol = tab.eol ?? 'lf'
  const target = path
  const write = (enc: TextEncoding) =>
    doc ? saveLargeDoc(doc, target, enc, eol) : api.writeFile(target, content, { encoding: enc, eol })
  if (doc) savingLarge.add(id)
  try {
    let mtime: number
    try {
      ;({ mtime } = await write(encoding))
    } catch (e) {
      // Characters the file's legacy encoding can't hold: offer UTF-8 instead of losing them.
      if (!errMsg(e).startsWith('EENCODE')) throw e
      const r = await api.showMessageBox({
        type: 'warning',
        message: t('confirm.encodeFailed', { name: basename(path), encoding: ENCODING_LABELS[encoding] }),
        detail: t('confirm.encodeFailedDetail'),
        buttons: [t('confirm.saveAsUtf8'), t('common.cancel')],
        defaultId: 0,
        cancelId: 1
      })
      if (r !== 0) return false
      encoding = 'utf8'
      ;({ mtime } = await write(encoding))
    }
    const changedPath = !samePath(path, tab.path)
    const kind = isMarkdownFile(path) ? 'markdown' : 'text'
    updateTab(id, {
      path,
      name: basename(path),
      kind,
      // A new document's file name now decides what it is.
      ...(tab.path ? {} : { language: kind === 'markdown' ? undefined : languageAfterSave(tab.language, basename(path)) }),
      ...(doc
        ? // Edits made while writing keep the tab modified.
          { dirty: editorBridge.getDoc(id) !== doc }
        : { content, saved: content }),
      encoding,
      eol,
      savedEol: eol,
      mtime,
      externalChange: false,
      deleted: false,
      builtin: false
    })
    if (changedPath) {
      api.addRecent(path, 'file')
      syncWatchedFiles()
    }
    if (!opts.quiet) toast(t('toast.saved', { name: basename(path) }), 'success', 1600)
    return true
  } catch (e) {
    toast(t('toast.saveFailed', { msg: errMsg(e) }), 'error')
    return false
  } finally {
    // The watcher reports our own write a moment later.
    if (doc) setTimeout(() => savingLarge.delete(id), 1500)
  }
}

export async function saveActive(saveAs = false): Promise<void> {
  const tab = activeTab()
  if (tab) await saveTab(tab.id, { saveAs })
}

export async function saveAll(): Promise<boolean> {
  for (const tab of getState().tabs.filter(isDirty)) {
    if (!(await saveTab(tab.id, { quiet: true }))) return false
  }
  return true
}

/** `stash` adds "Keep for Next Time" (closing a window, when every unsaved tab is backed up). */
async function confirmSave(names: string[], stash = false): Promise<'save' | 'stash' | 'discard' | 'cancel'> {
  const answers = stash ? (['save', 'stash', 'discard', 'cancel'] as const) : (['save', 'discard', 'cancel'] as const)
  const labels = { save: names.length === 1 ? t('common.save') : t('common.saveAll'), stash: t('common.stash'), discard: t('common.dontSave'), cancel: t('common.cancel') }
  const r = await api.showMessageBox({
    type: 'warning',
    message: names.length === 1 ? t('confirm.saveChanges', { name: names[0] }) : t('confirm.saveMany', { n: names.length }),
    detail: t(stash ? 'confirm.stashDetail' : 'confirm.saveChangesDetail'),
    buttons: answers.map((a) => labels[a]),
    defaultId: 0,
    cancelId: answers.length - 1
  })
  return answers[r] ?? 'cancel'
}

export async function closeTab(id: string, force = false): Promise<boolean> {
  flushPendingEdits()
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab) return true
  if (!force && isDirty(tab) && !tab.builtin) {
    const answer = await confirmSave([tab.name])
    if (answer === 'cancel') return false
    if (answer === 'save' && !(await saveTab(id))) return false
  }
  setState((s) => {
    const idx = s.tabs.findIndex((x) => x.id === id)
    const tabs = s.tabs.filter((x) => x.id !== id)
    let activeId = s.activeId
    if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
    const closedPaths = tab.path ? [...s.closedPaths.filter((p) => p !== tab.path), tab.path].slice(-20) : s.closedPaths
    return { tabs, activeId, closedPaths }
  })
  editorBridge.drop(id)
  largeDocs.delete(id)
  syncWatchedFiles()
  return true
}

export async function closeTabs(ids: string[]): Promise<void> {
  for (const id of ids) if (!(await closeTab(id))) return
}

export async function closeActiveTab(): Promise<void> {
  const tab = activeTab()
  if (tab) await closeTab(tab.id)
  else api.closeWindow()
}

export async function reopenClosedTab(): Promise<void> {
  const s = getState()
  const path = s.closedPaths[s.closedPaths.length - 1]
  if (!path) return
  setState({ closedPaths: s.closedPaths.slice(0, -1) })
  await openFile(path)
}

export function cycleTab(delta: number): void {
  const s = getState()
  if (s.tabs.length < 2) return
  const idx = s.tabs.findIndex((x) => x.id === s.activeId)
  const next = s.tabs[(idx + delta + s.tabs.length) % s.tabs.length]
  activate(next.id)
}

export async function handleBeforeClose(): Promise<void> {
  flushPendingEdits()
  const dirty = getState().tabs.filter((x) => isDirty(x) && !x.builtin)
  if (dirty.length) {
    const answer = await confirmSave(
      dirty.map((x) => x.name),
      dirty.every(canStash)
    )
    if (answer === 'cancel') {
      api.closeCancelled()
      return
    }
    if (answer === 'stash') {
      // Kept on disk as backups: the next window / launch reopens them unsaved.
      await stashBackups()
    } else if (answer === 'save') {
      for (const tab of dirty) {
        if (!(await saveTab(tab.id, { quiet: true }))) {
          api.closeCancelled()
          return
        }
      }
    } else {
      // Deliberately discarded: do not offer these edits again on the next launch.
      await discardBackups()
    }
  }
  persistSession()
  await settleBackups()
  api.closeWindow()
}

/**
 * Re-open documents that had unsaved changes when the app last crashed or was killed.
 * Returns the tabs that now own each backup so the backup tracker keeps using the same files.
 */
export async function restoreBackups(
  backups: BackupEntry[]
): Promise<Map<string, { backupId: string; content: string; path: string | null }>> {
  const adopted = new Map<string, { backupId: string; content: string; path: string | null }>()
  let last: Tab | null = null
  for (const b of backups) {
    let tab: Tab | null = null
    if (b.path) {
      const st = await api.stat(b.path)
      if (st?.isFile) {
        tab = await openFile(b.path)
        if (tab) {
          const current = getState().tabs.find((x) => x.id === tab!.id)!
          // The file changed on disk after these edits were made → let the user decide.
          const conflict = hashString(current.saved) !== b.savedHash && current.saved !== b.content
          editorBridge.setContent(tab.id, b.content)
          updateTab(tab.id, { content: b.content, externalChange: conflict, language: b.language })
        }
      } else {
        // The file is gone: keep the text, flagged as deleted so it can be saved elsewhere.
        tab = {
          id: newId(),
          path: b.path,
          name: b.name,
          kind: b.kind,
          language: b.language,
          content: b.content,
          saved: '',
          encoding: b.encoding,
          eol: b.eol,
          mtime: 0,
          externalChange: false,
          deleted: true
        }
        insertTab(tab)
      }
    } else {
      tab = newUntitled(b.content, b.name, false, { kind: b.kind, language: b.language })
    }
    if (tab) {
      adopted.set(tab.id, { backupId: b.id, content: b.content, path: b.path })
      last = tab
    }
  }
  if (last) {
    activate(last.id)
    toast(t('toast.restored', { n: adopted.size }), 'success', 6000)
  }
  syncWatchedFiles()
  return adopted
}

/* ------------------------------------------------------------------ */
/* External changes                                                    */
/* ------------------------------------------------------------------ */

export async function handleFileChanged(path: string, kind: 'change' | 'unlink'): Promise<void> {
  const tab = getState().tabs.find((x) => samePath(x.path, path))
  if (!tab || !isEditable(tab)) return
  if (kind === 'unlink') {
    // Editors that save via rename emit unlink + add; double-check before flagging.
    setTimeout(async () => {
      const st = await api.stat(path)
      if (!st) updateTab(tab.id, { deleted: true })
    }, 400)
    return
  }
  let data: FileData
  try {
    data = await api.readFile(path, tab.encoding)
  } catch {
    return
  }
  const cur = getState().tabs.find((x) => x.id === tab.id)
  if (!cur || data.binary) return
  if (cur.large) {
    // Compared by modification time: re-reading hundreds of MB on every event isn't an option.
    if (savingLarge.has(cur.id) || cur.loading !== undefined || Math.abs(data.mtime - cur.mtime) < 1) return
    if (isDirty(cur)) updateTab(cur.id, { externalChange: true, deleted: false })
    else if (cur.path) {
      updateTab(cur.id, { mtime: data.mtime, deleted: false })
      void startLargeLoad(cur.id, cur.path, cur.encoding)
    }
    return
  }
  if ('large' in data) return
  if (data.content === cur.saved) {
    if (cur.deleted) updateTab(cur.id, { deleted: false, mtime: data.mtime })
    return
  }
  if (!isDirty(cur)) {
    editorBridge.setContent(cur.id, data.content)
    updateTab(cur.id, { ...fromFile(data), deleted: false, externalChange: false })
  } else {
    updateTab(cur.id, { externalChange: true, deleted: false })
  }
}

export async function reloadTab(id: string): Promise<void> {
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab?.path) return
  if (tab.large) {
    const st = await api.stat(tab.path)
    if (st) updateTab(id, { mtime: st.mtime, size: st.size, deleted: false })
    void startLargeLoad(id, tab.path, tab.encoding)
    return
  }
  try {
    const data = await api.readFile(tab.path, tab.encoding)
    if (data.binary || 'large' in data) return
    editorBridge.setContent(id, data.content)
    updateTab(id, { ...fromFile(data), externalChange: false, deleted: false })
  } catch (e) {
    toast(t('toast.openFailed', { msg: errMsg(e) }), 'error')
  }
}

export function keepMine(id: string): void {
  updateTab(id, { externalChange: false })
}

/* ------------------------------------------------------------------ */
/* Encoding, line endings, syntax                                      */
/* ------------------------------------------------------------------ */

/** Re-read the file decoding it as `encoding` (for files whose encoding was guessed wrong). */
export async function reopenWithEncoding(id: string, encoding: TextEncoding): Promise<void> {
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab?.path || !isEditable(tab)) return
  if (isDirty(tab)) {
    const r = await api.showMessageBox({
      type: 'warning',
      message: t('confirm.reopenDiscard', { name: tab.name }),
      buttons: [t('confirm.reopen'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1
    })
    if (r !== 0) return
  }
  if (tab.large) {
    void startLargeLoad(id, tab.path, encoding)
    return
  }
  try {
    const data = await api.readFile(tab.path, encoding)
    if (data.binary) return
    if ('large' in data) {
      updateTab(id, { ...fromFile(data) })
      void startLargeLoad(id, tab.path, encoding)
      return
    }
    editorBridge.setContent(id, data.content, 'reopen')
    updateTab(id, { ...fromFile(data), externalChange: false })
  } catch (e) {
    toast(t('toast.openFailed', { msg: errMsg(e) }), 'error')
  }
}

/** Show a file the binary view rejected as text anyway (decoded as UTF-8). */
export async function openAsText(id: string): Promise<void> {
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab?.path) return
  try {
    const data = await api.readFile(tab.path, 'utf8')
    if (data.binary) return
    updateTab(id, { ...fromFile(data), kind: isMarkdownFile(tab.path) ? 'markdown' : 'text' })
    if ('large' in data) void startLargeLoad(id, tab.path, 'utf8')
  } catch (e) {
    toast(t('toast.openFailed', { msg: errMsg(e) }), 'error')
  }
}

/** Save the document in another encoding (e.g. convert GB18030 to UTF-8). */
export async function saveWithEncoding(id: string, encoding: TextEncoding): Promise<void> {
  await saveTab(id, { encoding })
}

/** Switch LF / CRLF; takes effect (and marks the document modified) until the next save. */
export function setLineEnding(id: string, eol: LineEnding): void {
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab || !isEditable(tab) || (tab.eol ?? 'lf') === eol) return
  updateTab(id, { eol, savedEol: tab.savedEol ?? tab.eol ?? 'lf' })
}

/** Choose the syntax of a text tab ('plain', a language name, or undefined to detect it again). */
export function setTabLanguage(id: string, language: string | undefined): void {
  updateTab(id, { language })
}

/**
 * Choose what a new document is (PLAIN_TEXT, MARKDOWN_TYPE or a syntax name). The text and its
 * undo history stay; the tab name, syntax and the file the save dialog offers follow.
 */
export function setDocumentType(id: string, type: string): void {
  flushPendingEdits()
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab || !isNewDocument(tab)) return
  // A type picked by hand stays, whatever is typed next.
  applyDocumentType(tab, type, { autoType: false })
  setTimeout(() => editorBridge.focus(), 50)
}

/** Let a new document's type follow its content again (and detect it now). */
export function setDocumentTypeAuto(id: string): void {
  flushPendingEdits()
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab || !isNewDocument(tab)) return
  updateTab(id, { autoType: true })
  detectDocumentType(id)
  setTimeout(() => editorBridge.focus(), 50)
}

function applyDocumentType(tab: Tab, type: string, extra: Partial<Tab> = {}): void {
  const markdown = type === MARKDOWN_TYPE
  updateTab(tab.id, {
    name: nameForType(tab.name, type),
    kind: markdown ? 'markdown' : 'text',
    language: markdown ? undefined : type,
    ...extra
  })
  const s = getState()
  // Like a freshly created Markdown document, it opens for writing.
  if (markdown && s.viewMode === 'preview') setViewMode(s.lastEditMode)
}

/** Waits for a pause in typing so the type doesn't flicker while a word is half written. */
const TYPE_DETECT_DELAY = 400
const typeDetectTimers = new Map<string, number>()
function scheduleTypeDetection(id: string): void {
  clearTimeout(typeDetectTimers.get(id))
  typeDetectTimers.set(
    id,
    window.setTimeout(() => {
      typeDetectTimers.delete(id)
      detectDocumentType(id)
    }, TYPE_DETECT_DELAY)
  )
}

/** Give an auto-typed new document the type its text looks like (Markdown for prose). */
function detectDocumentType(id: string): void {
  const tab = getState().tabs.find((x) => x.id === id)
  if (!tab?.autoType || !isNewDocument(tab) || tab.large) return
  const type = detectContentType(tab.content) ?? MARKDOWN_TYPE
  if (type === documentType(tab, tab.content)) return
  const hadFocus = tab.id === getState().activeId && !!editorBridge.view?.hasFocus
  applyDocumentType(tab, type)
  // Switching between Markdown and code re-attaches the editor; keep typing where you were.
  if (hadFocus) setTimeout(() => editorBridge.focus(), 0)
}

/* ------------------------------------------------------------------ */
/* File tree operations                                                */
/* ------------------------------------------------------------------ */

export async function refreshTree(): Promise<void> {
  const tree = await api.refreshWorkspace(scanOptions())
  if (tree) setState({ tree })
}

export function toggleExpanded(path: string, value?: boolean): void {
  setState((s) => ({ expanded: { ...s.expanded, [path]: value ?? !s.expanded[path] } }))
}

export function expandTo(path: string): void {
  const s = getState()
  if (!s.root || !isInside(path, s.root)) return
  const expanded = { ...s.expanded }
  let dir = dirname(path)
  while (isInside(dir, s.root)) {
    expanded[dir] = true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  setState({ expanded })
}

export async function createEntry(dir: string, name: string, type: 'file' | 'dir'): Promise<void> {
  let finalName = name.trim()
  if (!finalName) return
  if (type === 'file' && !/\.[^./\\]+$/.test(finalName)) finalName += '.md'
  const path = join(dir, finalName)
  try {
    if (type === 'file') await api.createFile(path, '')
    else await api.createDir(path)
  } catch (e) {
    const msg = errMsg(e)
    toast(/EEXIST/.test(msg) ? t('toast.nameExists', { name: finalName }) : t('toast.createFailed', { msg }), 'error')
    return
  }
  toggleExpanded(dir, true)
  await refreshTree()
  if (type === 'file') {
    await openFile(path)
    const s = getState()
    if (s.viewMode === 'preview') setViewMode(s.lastEditMode)
    setTimeout(() => editorBridge.focus(), 80)
  }
}

export async function renameEntry(path: string, newName: string): Promise<void> {
  const name = newName.trim()
  if (!name || name === basename(path)) return
  const target = join(dirname(path), name)
  try {
    await api.rename(path, target)
  } catch (e) {
    const msg = errMsg(e)
    toast(/EEXIST/.test(msg) ? t('toast.nameExists', { name }) : t('toast.renameFailed', { msg }), 'error')
    return
  }
  setState((s) => ({
    tabs: s.tabs.map((tab) => {
      if (!tab.path || !isInside(tab.path, path)) return tab
      const p = target + tab.path.slice(path.length)
      return { ...tab, path: p, name: basename(p) }
    }),
    expanded: Object.fromEntries(
      Object.entries(s.expanded).map(([k, v]) => [isInside(k, path) ? target + k.slice(path.length) : k, v])
    )
  }))
  syncWatchedFiles()
  await refreshTree()
}

export async function deleteEntry(path: string): Promise<void> {
  const r = await api.showMessageBox({
    type: 'warning',
    message: t('confirm.delete', { name: basename(path) }),
    detail: t('confirm.deleteDetail'),
    buttons: [t('common.delete'), t('common.cancel')],
    defaultId: 0,
    cancelId: 1
  })
  if (r !== 0) return
  try {
    await api.trash(path)
  } catch (e) {
    toast(errMsg(e), 'error')
    return
  }
  for (const tab of getState().tabs.filter((x) => x.path && isInside(x.path, path))) {
    if (isDirty(tab)) updateTab(tab.id, { deleted: true })
    else await closeTab(tab.id, true)
  }
  await refreshTree()
}

export function flattenTree(node: TreeNode | null, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out
  if (node.type === 'file') out.push(node)
  node.children?.forEach((c) => flattenTree(c, out))
  return out
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

export async function openWikilink(target: string): Promise<void> {
  const s = getState()
  const [rawName, heading] = target.split('#')
  const name = rawName.trim()
  const anchor = heading ? slugify(heading) : undefined
  const current = activeTab(s)
  if (!name) {
    if (anchor && current) requestReveal(current.id, { anchor })
    return
  }
  const lower = name.toLowerCase().replace(/\\/g, '/')
  const baseDir = current?.path ? dirname(current.path) : s.root
  // 1. relative to the current document
  if (baseDir) {
    for (const candidate of [name, `${name}.md`, `${name}.markdown`]) {
      const p = resolve(baseDir, candidate)
      const st = await api.stat(p)
      if (st?.isFile) {
        await openFile(p, { anchor })
        return
      }
    }
  }
  // 2. anywhere in the workspace, by file name
  const files = flattenTree(s.tree)
  const match =
    files.find((f) => basename(f.name).replace(/\.(md|markdown|mdx?)$/i, '').toLowerCase() === lower) ??
    files.find((f) => f.path.replace(/\\/g, '/').toLowerCase().endsWith('/' + lower + '.md')) ??
    files.find((f) => f.name.toLowerCase() === lower)
  if (match) {
    await openFile(match.path, { anchor })
    return
  }
  toast(t('toast.wikilinkNotFound', { name }), 'error')
}

export async function followLink(href: string): Promise<void> {
  const s = getState()
  const tab = activeTab(s)
  if (/^(https?|mailto):/i.test(href)) {
    await api.openExternal(href)
    return
  }
  if (href.startsWith('#')) {
    if (tab) requestReveal(tab.id, { anchor: decodeURIComponent(href.slice(1)) })
    return
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-zA-Z]:[\\/]/.test(href) && !/^file:/i.test(href)) return
  const hashIdx = href.indexOf('#')
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href
  const anchor = hashIdx >= 0 ? decodeURIComponent(href.slice(hashIdx + 1)) : undefined
  let path = rawPath.replace(/\?.*$/, '')
  try {
    path = decodeURI(path)
  } catch {
    /* keep */
  }
  if (/^file:/i.test(path)) path = fileUrlToPath(path)
  const baseDir = tab?.path ? dirname(tab.path) : s.root
  if (!baseDir && !/^([a-zA-Z]:)?[\\/]/.test(path)) return
  const abs = resolve(baseDir ?? '/', path)
  const st = await api.stat(abs)
  if (!st) {
    // Allow extension-less links to Markdown files: [x](notes/page)
    const md = await api.stat(abs + '.md')
    if (md?.isFile) await openFile(abs + '.md', { anchor })
    else toast(t('toast.openFailed', { msg: abs }), 'error')
    return
  }
  if (st.isDirectory) {
    await openFolder(abs)
    return
  }
  await openFile(abs, { anchor })
}

/* ------------------------------------------------------------------ */
/* View / settings                                                     */
/* ------------------------------------------------------------------ */

export function setViewMode(mode: ViewMode): void {
  if (mode !== 'edit' && activeTab()?.large) toast(t('large.noPreview'))
  setState((s) => ({ viewMode: mode, lastEditMode: mode === 'preview' ? s.lastEditMode : mode }))
}

export function toggleViewMode(): void {
  const s = getState()
  setViewMode(s.viewMode === 'preview' ? s.lastEditMode : 'preview')
}

export async function updateSettings(partial: Partial<Settings>): Promise<void> {
  applySettings({ ...getState().settings, ...partial })
  const next = await api.setSettings(partial)
  applySettings(next)
}

export function applySettings(settings: Settings): void {
  const prev = getState().settings
  setState((s) => ({ settings, locale: resolveLocale(settings.language, s.systemLocale) }))
  if (prev.showAllFiles !== settings.showAllFiles || prev.showHiddenFiles !== settings.showHiddenFiles) {
    void refreshTree()
  }
}

export function toggleSidebar(panel?: 'files' | 'outline' | 'search'): void {
  setState((s) => {
    if (!panel) return { sidebarVisible: !s.sidebarVisible }
    if (s.sidebarVisible && s.sidebarPanel === panel && panel !== 'search') return { sidebarVisible: false }
    return { sidebarVisible: true, sidebarPanel: panel, searchFocusSeq: panel === 'search' ? s.searchFocusSeq + 1 : s.searchFocusSeq }
  })
}

export async function setDefaultApp(): Promise<void> {
  const r = await api.setDefaultApp()
  if (r.ok) toast(r.action === 'windows-settings' ? t('toast.defaultAppWindows') : t('toast.defaultAppSet'), 'success', 5000)
  else toast(t('toast.defaultAppFailed', { msg: r.message ?? '' }), 'error', 6000)
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export function persistSession(): void {
  const s = getState()
  const active = activeTab(s)
  api.setSession({
    root: s.root,
    files: s.tabs.map((x) => x.path).filter((p): p is string => !!p),
    active: active?.path ?? null
  })
}

let sessionTimer = 0
function schedulePersist(): void {
  clearTimeout(sessionTimer)
  sessionTimer = window.setTimeout(persistSession, 600)
}

function documentTitle(): void {
  const s = getState()
  const tab = activeTab(s)
  const parts: string[] = []
  if (tab) parts.push(`${tab.name}${isDirty(tab) ? ' •' : ''}`)
  if (s.root) parts.push(basename(s.root))
  parts.push('MarkFlow')
  const title = parts.join(' — ')
  document.title = title
  api.setDocumentState({ path: tab?.path ?? null, dirty: tab ? isDirty(tab) : false, title })
}

export function startPersistence(): void {
  let prevKey = ''
  let prevTitle = ''
  useStore.subscribe((s) => {
    const key = JSON.stringify([s.root, s.tabs.map((x) => x.path), s.activeId])
    if (key !== prevKey) {
      prevKey = key
      if (s.ready) schedulePersist()
    }
    const tab = activeTab(s)
    const titleKey = `${tab?.id}|${tab?.name}|${tab ? isDirty(tab) : ''}|${s.root}`
    if (titleKey !== prevTitle) {
      prevTitle = titleKey
      documentTitle()
    }
  })
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

let blockEditFlush: (() => void) | null = null
/** The preview registers this while a block is being edited inline. */
export function registerBlockEditFlush(fn: (() => void) | null): void {
  blockEditFlush = fn
}
/** Commit an in-progress inline block edit so save / close / export see it. */
export function flushPendingEdits(): void {
  blockEditFlush?.()
}

let previewWaiter: (() => Promise<void>) | null = null
export function registerPreviewWaiter(fn: (() => Promise<void>) | null): void {
  previewWaiter = fn
}

async function withPreviewVisible<T>(fn: () => Promise<T>, light = false): Promise<T> {
  flushPendingEdits()
  const s = getState()
  const restore = s.viewMode === 'edit' ? 'edit' : null
  if (restore) setViewMode('preview')
  if (light) setState({ forceLight: true })
  await new Promise((r) => setTimeout(r, 80))
  await previewWaiter?.()
  try {
    return await fn()
  } finally {
    if (light) setState({ forceLight: false })
    if (restore) setViewMode(restore)
  }
}

function exportBaseName(tab: Tab): string {
  return basename(tab.name).replace(/\.[^.]+$/, '')
}

/** Export / print render the preview, which large files don't have. */
function largeBlocked(tab: Tab): boolean {
  if (tab.large) toast(t('large.noPreview'))
  return !!tab.large
}

export async function exportPdf(): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.kind !== 'markdown' || largeBlocked(tab)) return
  const s = getState()
  const dir = tab.path ? dirname(tab.path) : (s.root ?? s.homeDir)
  try {
    const out = await withPreviewVisible(() => api.exportPDF(join(dir, exportBaseName(tab) + '.pdf')), true)
    if (out) toast(t('toast.exported', { path: out }), 'success', 4000)
  } catch (e) {
    toast(t('toast.exportFailed', { msg: errMsg(e) }), 'error')
  }
}

export async function printDocument(): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.kind !== 'markdown' || largeBlocked(tab)) return
  await withPreviewVisible(() => api.print(), true)
}

export async function exportHtml(): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.kind !== 'markdown' || largeBlocked(tab)) return
  const s = getState()
  const dir = tab.path ? dirname(tab.path) : (s.root ?? s.homeDir)
  const target = await api.showSaveDialog(join(dir, exportBaseName(tab) + '.html'), [
    { name: 'HTML', extensions: ['html', 'htm'] }
  ])
  if (!target) return
  try {
    const { buildStandaloneHtml } = await import('@/lib/exportHtml')
    const html = await withPreviewVisible(async () => buildStandaloneHtml(exportBaseName(tab), dirname(target)))
    await api.writeFile(target, html)
    toast(t('toast.exported', { path: target }), 'success', 4000)
  } catch (e) {
    toast(t('toast.exportFailed', { msg: errMsg(e) }), 'error')
  }
}

/* ------------------------------------------------------------------ */
/* Menu commands                                                       */
/* ------------------------------------------------------------------ */

/**
 * The editor a command should act on: the focused CodeMirror view (main editor or an inline
 * block editor), else the main editor when it is visible and no other text field has focus.
 */
export function targetEditorView(): EditorView | null {
  const el = document.activeElement as HTMLElement | null
  const cm = el?.closest?.('.cm-editor') as HTMLElement | null
  if (cm) return EditorView.findFromDOM(cm)
  if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return null
  const s = getState()
  const tab = activeTab(s)
  if (!tab || !isEditable(tab) || editorBridge.currentTabId !== tab.id) return null
  if (tab.kind === 'text' || s.viewMode !== 'preview') return editorBridge.view
  return null
}

function formatIfEditing(cmd: FormatCommand): void {
  const view = targetEditorView()
  if (view) editorCommand(`format-${cmd}` as MenuCommand, view)
}

/** Where a find-option toggle (⌥⌘R / ⌥⌘C / ⌥⌘W) should apply, if a find field has focus. */
function findContext(): 'editor' | 'preview' | 'folder' | null {
  const el = document.activeElement as HTMLElement | null
  if (!el) return null
  if (el.closest('.cm-find-panel')) return 'editor'
  if (el.closest('.findbar')) return 'preview'
  if (el.closest('.search-box')) return 'folder'
  return null
}

function toggleFindOption(option: 'regexp' | 'caseSensitive' | 'wholeWord'): boolean {
  const ctx = findContext()
  if (ctx === 'editor') {
    const cm = document.activeElement?.closest('.cm-editor') as HTMLElement | null
    const view = cm ? EditorView.findFromDOM(cm) : null
    return !!view && toggleSearchOption(view, option)
  }
  if (ctx === 'preview' || ctx === 'folder') {
    window.dispatchEvent(new CustomEvent(ctx === 'preview' ? 'mf-findbar-toggle' : 'mf-search-toggle', { detail: option }))
    return true
  }
  return false
}

/** Text selected in the preview (reading mode), single line only. */
function previewSelection(): string {
  const text = window.getSelection()?.toString().trim() ?? ''
  return text.includes('\n') ? '' : text
}

let findSeedSeq = 0
function seedPreviewFind(text: string): void {
  setState({ findOpen: true, findSeed: { text, seq: ++findSeedSeq } })
}

function selectTab(n: number): void {
  const tab = getState().tabs[n - 1]
  if (tab) activate(tab.id)
}

setLocationProvider((tabId) => {
  const s = getState()
  const tab = s.tabs.find((x) => x.id === tabId)
  if (!tab || !isEditable(tab)) return null
  if (tab.kind === 'markdown' && s.viewMode === 'preview') return Math.floor(previewTopLine())
  const view = editorBridge.view
  if (view && editorBridge.currentTabId === tabId) return view.state.doc.lineAt(view.state.selection.main.head).number - 1
  return null
})

async function navigateTo(loc: NavLocation): Promise<boolean> {
  let tab = getState().tabs.find((x) => x.id === loc.tabId) ?? getState().tabs.find((x) => loc.path && samePath(x.path, loc.path))
  if (!tab && loc.path) tab = (await openFile(loc.path)) ?? undefined
  if (!tab) return false
  setState({ activeId: tab.id })
  requestReveal(tab.id, { line: loc.line })
  return true
}

/** Bookmarks live in the editor state, but also work from reading mode. */
function runBookmark(cmd: 'bookmark-toggle' | 'bookmark-next' | 'bookmark-prev' | 'bookmark-clear'): void {
  const s = getState()
  const tab = activeTab(s)
  const view = editorBridge.view
  if (!tab || !isEditable(tab) || !view || editorBridge.currentTabId !== tab.id) return
  const reading = tab.kind === 'markdown' && s.viewMode === 'preview'
  if (cmd === 'bookmark-toggle') {
    if (reading) editorBridge.revealLine(Math.floor(previewTopLine()))
    toggleBookmark(view)
    return
  }
  if (cmd === 'bookmark-clear') {
    editorCommand('bookmark-clear', view)
    return
  }
  if (!bookmarkLines(view.state).length) {
    toast(t('toast.noBookmarks'))
    return
  }
  recordJump()
  const line = gotoBookmark(view, cmd === 'bookmark-next')
  if (line >= 0 && reading) requestReveal(tab.id, { line })
}

function toggleFocusMode(): void {
  const next = !getState().focusMode
  setState({ focusMode: next })
  api.setFullScreen(next)
}

/** Find next / previous / replace / use-selection: editor when editing, else the preview find bar. */
function runFind(cmd: 'find-next' | 'find-prev' | 'replace' | 'use-selection-find'): void {
  const view = targetEditorView()
  if (view) {
    if (cmd === 'use-selection-find') seedFindFromSelection(view)
    else editorCommand(cmd, view)
    return
  }
  const s = getState()
  const tab = activeTab(s)
  if (!tab || tab.kind !== 'markdown') return
  if (cmd === 'replace') {
    // Replacing needs the source: switch to editing and open the replace field.
    setViewMode(s.lastEditMode)
    setTimeout(() => editorBridge.view && openReplace(editorBridge.view), 60)
    return
  }
  const sel = previewSelection()
  if (cmd === 'use-selection-find') {
    if (sel) seedPreviewFind(sel)
    return
  }
  if (!s.findOpen || sel) seedPreviewFind(sel)
  else window.dispatchEvent(new CustomEvent('mf-findbar-step', { detail: cmd === 'find-next' ? 1 : -1 }))
}

function undoRedoContextual(kind: 'undo' | 'redo'): void {
  const el = document.activeElement as HTMLElement | null
  const cm = el?.closest?.('.cm-editor') as HTMLElement | null
  const view = cm ? EditorView.findFromDOM(cm) : null
  if (view) {
    ;(kind === 'undo' ? undo : redo)(view)
    return
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    document.execCommand(kind)
    return
  }
  // Reading mode: undo edits made through the preview (block edits, task checkboxes).
  if (kind === 'undo') editorBridge.undo()
  else editorBridge.redo()
}

function selectAllContextual(): void {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select()
    return
  }
  if (editorBridge.hasFocus()) {
    editorBridge.selectAll()
    return
  }
  const preview = document.querySelector('.markdown-body')
  if (preview) {
    const range = document.createRange()
    range.selectNodeContents(preview)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
}

export function runMenuCommand(cmd: MenuCommand): void {
  const s = getState()
  if (cmd.startsWith('format-')) {
    // ⌥⌘C is both "code block" and Sublime's "toggle case" inside a find field.
    if (cmd === 'format-codeblock' && findContext()) {
      toggleFindOption('caseSensitive')
      return
    }
    formatIfEditing(cmd.slice(7) as FormatCommand)
    return
  }
  const tabMatch = /^tab-(\d)$/.exec(cmd)
  if (tabMatch) return selectTab(Number(tabMatch[1]))
  const def = COMMAND_MAP.get(cmd)
  if (def?.scope === 'editor') {
    const view = targetEditorView()
    if (!view) return
    // ⌘↩ (insert line after) finishes an inline block edit instead.
    if (cmd === 'insert-line-after' && view.dom.closest('.mf-block-editor')) {
      view.dom.dispatchEvent(new Event('mf-block-finish'))
      return
    }
    editorCommand(cmd, view)
    return
  }
  switch (cmd) {
    case 'new-window':
      return api.newWindow()
    case 'close-window':
      return window.close()
    case 'command-palette':
      return setState({ palette: '>' })
    case 'goto-heading':
      return setState({ palette: '@' })
    case 'goto-heading-project':
      return setState({ palette: '#' })
    case 'goto-line':
      return setState({ palette: ':' })
    case 'find-next':
    case 'find-prev':
    case 'replace':
    case 'use-selection-find':
      return runFind(cmd)
    case 'find-toggle-regex':
      return void toggleFindOption('regexp')
    case 'find-toggle-case':
      return void toggleFindOption('caseSensitive')
    case 'find-toggle-word':
      return void toggleFindOption('wholeWord')
    case 'jump-back':
      return void jumpBack(navigateTo)
    case 'jump-forward':
      return void jumpForward(navigateTo)
    case 'bookmark-toggle':
    case 'bookmark-next':
    case 'bookmark-prev':
    case 'bookmark-clear':
      return runBookmark(cmd)
    case 'focus-mode':
      return toggleFocusMode()
    case 'new-file':
      return newFile()
    case 'open-file':
      return void showOpenFile()
    case 'open-folder':
      return void showOpenFolder()
    case 'close-folder':
      return void closeFolder()
    case 'save':
      return void saveActive(false)
    case 'save-as':
      return void saveActive(true)
    case 'save-all':
      return void saveAll()
    case 'close-tab':
      return void closeActiveTab()
    case 'reopen-closed-tab':
      return void reopenClosedTab()
    case 'export-html':
      return void exportHtml()
    case 'export-pdf':
      return void exportPdf()
    case 'print':
      return void printDocument()
    case 'quick-open':
      return setState({ palette: '' })
    case 'find': {
      const tab = activeTab(s)
      const editorVisible = tab && isEditable(tab) && (s.viewMode !== 'preview' || tab.kind === 'text')
      if (editorVisible && (editorBridge.hasFocus() || s.viewMode === 'edit' || tab.kind === 'text')) editorBridge.openSearch()
      else setState({ findOpen: true })
      return
    }
    case 'select-all':
      return selectAllContextual()
    case 'undo':
    case 'redo':
      return undoRedoContextual(cmd)
    case 'search-in-folder':
      return toggleSidebar('search')
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'show-files':
      return toggleSidebar('files')
    case 'show-outline':
      return toggleSidebar('outline')
    case 'show-search':
      return toggleSidebar('search')
    case 'view-preview':
      return setViewMode('preview')
    case 'view-edit':
      return setViewMode('edit')
    case 'view-split':
      return setViewMode('split')
    case 'toggle-view':
      return toggleViewMode()
    case 'theme-light':
      return void updateSettings({ theme: 'light' })
    case 'theme-dark':
      return void updateSettings({ theme: 'dark' })
    case 'theme-system':
      return void updateSettings({ theme: 'system' })
    case 'settings':
      return setState({ settingsOpen: true })
    case 'next-tab':
      return cycleTab(1)
    case 'prev-tab':
      return cycleTab(-1)
    case 'about':
      return setState({ aboutOpen: true })
    case 'clear-recent':
      return api.clearRecent()
    case 'markdown-guide':
      return openGuide()
    case 'set-default-app':
      return void setDefaultApp()
    case 'check-updates':
      setState({ settingsOpen: true, settingsSection: 'update' })
      return void api.checkForUpdates()
    default:
      return
  }
}
