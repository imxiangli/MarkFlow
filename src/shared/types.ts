import type { UpdateState } from './update'

export type Platform = 'darwin' | 'win32' | 'linux' | 'freebsd' | 'openbsd' | 'netbsd' | 'sunos' | 'aix' | 'android' | 'haiku' | 'cygwin'

export type ViewMode = 'preview' | 'edit' | 'split'
export type ThemeSetting = 'system' | 'light' | 'dark'
export type LanguageSetting = 'auto' | 'zh-CN' | 'en'
export type PreviewWidth = 'narrow' | 'medium' | 'wide' | 'full'

export interface Settings {
  language: LanguageSetting
  theme: ThemeSetting
  viewMode: ViewMode
  editorFontSize: number
  editorFontFamily: string
  previewFontSize: number
  previewFontFamily: string
  previewWidth: PreviewWidth
  lineNumbers: boolean
  lineWrapping: boolean
  autoSave: boolean
  syncScroll: boolean
  showAllFiles: boolean
  showHiddenFiles: boolean
  openParentFolder: boolean
  restoreSession: boolean
  imageFolder: string
  enablePlantUML: boolean
  plantumlServer: string
  sidebarWidth: number
  splitRatio: number
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  updateUrl: string
  dblclickToEdit: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'auto',
  theme: 'system',
  viewMode: 'preview',
  editorFontSize: 14,
  editorFontFamily: '',
  previewFontSize: 16,
  previewFontFamily: '',
  previewWidth: 'medium',
  lineNumbers: true,
  lineWrapping: true,
  autoSave: false,
  syncScroll: true,
  showAllFiles: false,
  showHiddenFiles: false,
  openParentFolder: false,
  restoreSession: true,
  imageFolder: 'assets',
  enablePlantUML: false,
  plantumlServer: 'https://www.plantuml.com/plantuml',
  sidebarWidth: 260,
  splitRatio: 0.5,
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
  updateUrl: '',
  dblclickToEdit: true
}

export interface RecentItem {
  path: string
  kind: 'file' | 'folder'
  time: number
}

export interface SessionState {
  root: string | null
  files: string[]
  active: string | null
}

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

export interface ScanOptions {
  showAllFiles: boolean
  showHiddenFiles: boolean
}

/** Text encodings MarkFlow can read and write (legacy ones via iconv-lite in the main process). */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gb18030' | 'big5' | 'shift_jis' | 'euc-kr' | 'windows-1252'
export type LineEnding = 'lf' | 'crlf'

export interface TextFileData {
  binary: false
  path: string
  /** Always uses "\n" line breaks; `eol` says what the file uses on disk. */
  content: string
  mtime: number
  size: number
  encoding: TextEncoding
  eol: LineEnding
}

/** A file that isn't text (or is too large to sniff as text): only metadata is read. */
export interface BinaryFileData {
  binary: true
  path: string
  mtime: number
  size: number
  /** Text, but over the size limit for the editor. */
  tooLarge?: boolean
}

/** A text file too big to send in one piece: its text is streamed with largeOpen / largeRead. */
export interface LargeFileData {
  binary: false
  large: true
  path: string
  mtime: number
  size: number
}

export type FileData = TextFileData | LargeFileData | BinaryFileData

export interface LargeReadStart {
  id: string
  size: number
  encoding: TextEncoding
}

export interface LargeChunk {
  /**
   * Whole lines of decoded text: split each part on "\n" and append the lines in order. Parts
   * alternate between Latin-1-only lines (stored compactly) and lines with wider characters.
   */
  segments: string[]
  /** Bytes read so far (for progress). */
  read: number
  done: boolean
  /** Set when the guessed encoding was wrong: drop what was received and start over. */
  restart?: TextEncoding
  eol?: LineEnding
}

export interface WriteOptions {
  encoding?: TextEncoding
  eol?: LineEnding
}

export interface StatResult {
  isFile: boolean
  isDirectory: boolean
  mtime: number
  size: number
}

export interface HeadingEntry {
  path: string
  /** 0-based line. */
  line: number
  level: number
  text: string
}

export interface SearchOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

export interface SearchMatch {
  line: number
  column: number
  length: number
  /** Display snippet of the line. */
  text: string
  /** Offset of the match inside `text`. */
  textOffset: number
}

export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}

/** Unsaved editor content kept on disk so it survives crashes / forced quits. */
export interface BackupEntry {
  /** Random, stable per tab; also the backup file name. */
  id: string
  /** null for new, never-saved documents. */
  path: string | null
  name: string
  kind: 'markdown' | 'text'
  /** Syntax chosen by the user ('plain' = none), like the tab's. */
  language?: string
  content: string
  encoding?: TextEncoding
  eol?: LineEnding
  /** Hash of the on-disk content the edits were based on (detects later external changes). */
  savedHash: string
  time: number
}

export interface InitialState {
  settings: Settings
  recent: RecentItem[]
  session: SessionState | null
  locale: string
  platform: Platform
  version: string
  homeDir: string
  isFirstWindow: boolean
  isPackaged: boolean
  /** Unsaved documents left behind by a crash; only handed to the first window at startup. */
  backups: BackupEntry[]
}

export type FileChangeKind = 'change' | 'unlink'

export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

export type MenuCommand =
  | 'new-file'
  | 'open-file'
  | 'open-folder'
  | 'close-folder'
  | 'save'
  | 'save-as'
  | 'save-all'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'export-html'
  | 'export-pdf'
  | 'print'
  | 'quick-open'
  | 'find'
  | 'select-all'
  | 'undo'
  | 'redo'
  | 'set-default-app'
  | 'search-in-folder'
  | 'toggle-sidebar'
  | 'show-files'
  | 'show-outline'
  | 'show-search'
  | 'view-preview'
  | 'view-edit'
  | 'view-split'
  | 'toggle-view'
  | 'theme-light'
  | 'theme-dark'
  | 'theme-system'
  | 'settings'
  | 'format-bold'
  | 'format-italic'
  | 'format-strike'
  | 'format-code'
  | 'format-link'
  | 'format-image'
  | 'format-h1'
  | 'format-h2'
  | 'format-h3'
  | 'format-h4'
  | 'format-h5'
  | 'format-h6'
  | 'format-quote'
  | 'format-ul'
  | 'format-ol'
  | 'format-task'
  | 'format-codeblock'
  | 'format-table'
  | 'format-hr'
  | 'format-math'
  | 'next-tab'
  | 'prev-tab'
  | 'about'
  | 'open-recent'
  | 'clear-recent'
  | 'markdown-guide'
  | 'check-updates'
  // Sublime Text style commands
  | 'new-window'
  | 'close-window'
  | 'paste-indent'
  | 'indent'
  | 'outdent'
  | 'swap-line-up'
  | 'swap-line-down'
  | 'duplicate-line'
  | 'delete-line'
  | 'join-lines'
  | 'insert-line-after'
  | 'insert-line-before'
  | 'delete-to-eol'
  | 'delete-to-bol'
  | 'toggle-comment'
  | 'toggle-block-comment'
  | 'upper-case'
  | 'lower-case'
  | 'fold'
  | 'unfold'
  | 'fold-all'
  | 'unfold-all'
  | `fold-level-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | 'sort-lines'
  | 'sort-lines-case'
  | 'split-into-lines'
  | 'add-cursor-above'
  | 'add-cursor-below'
  | 'select-line'
  | 'select-next-occurrence'
  | 'skip-occurrence'
  | 'select-all-occurrences'
  | 'soft-undo'
  | 'expand-brackets'
  | 'expand-indentation'
  | 'expand-scope'
  | 'find-next'
  | 'find-prev'
  | 'replace'
  | 'quick-find-next'
  | 'use-selection-find'
  | 'find-toggle-regex'
  | 'find-toggle-case'
  | 'find-toggle-word'
  | 'command-palette'
  | 'goto-heading'
  | 'goto-heading-project'
  | 'goto-line'
  | 'jump-back'
  | 'jump-forward'
  | 'jump-bracket'
  | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | 'bookmark-toggle'
  | 'bookmark-next'
  | 'bookmark-prev'
  | 'bookmark-clear'
  | 'focus-mode'

export interface MarkFlowAPI {
  platform: Platform
  getInitialState(): Promise<InitialState>
  rendererReady(): void
  onOpenPaths(cb: (paths: string[]) => void): () => void
  onMenuCommand(cb: (cmd: MenuCommand, arg?: unknown) => void): () => void
  onBeforeClose(cb: () => void): () => void
  onSettingsChanged(cb: (settings: Settings) => void): () => void
  onRecentChanged(cb: (recent: RecentItem[]) => void): () => void
  onTreeChanged(cb: (tree: TreeNode) => void): () => void
  onFileChanged(cb: (path: string, kind: FileChangeKind) => void): () => void
  closeWindow(): void
  closeCancelled(): void
  newWindow(): void

  showOpenFile(defaultPath?: string): Promise<string[] | null>
  showOpenFolder(): Promise<string | null>
  showSaveDialog(defaultPath: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  showMessageBox(options: MessageBoxOptions): Promise<number>

  /** Reads a file, detecting binary content, the encoding (unless given) and line endings. */
  readFile(path: string, encoding?: TextEncoding): Promise<FileData>
  /** Writes text in the given encoding / line endings (UTF-8 + LF by default). */
  writeFile(path: string, content: string, options?: WriteOptions): Promise<{ mtime: number }>
  /** The OS file-type icon as a data URL (null when unavailable). */
  fileIcon(path: string): Promise<string | null>
  /** Large files: stream the text in chunks / write it back in chunks. */
  largeOpen(path: string, encoding?: TextEncoding): Promise<LargeReadStart>
  largeRead(id: string): Promise<LargeChunk>
  largeClose(id: string): Promise<void>
  largeWriteBegin(path: string, options: { encoding: TextEncoding; eol: LineEnding }): Promise<string>
  largeWriteChunk(id: string, text: string): Promise<void>
  largeWriteEnd(id: string): Promise<{ mtime: number }>
  largeWriteAbort(id: string): Promise<void>
  stat(path: string): Promise<StatResult | null>
  createFile(path: string, content?: string): Promise<void>
  createDir(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  trash(path: string): Promise<void>
  saveImage(dir: string, fileName: string, data: ArrayBuffer): Promise<string>
  copyFile(src: string, dest: string): Promise<void>

  openWorkspace(root: string, options: ScanOptions): Promise<TreeNode>
  refreshWorkspace(options: ScanOptions): Promise<TreeNode | null>
  closeWorkspace(): Promise<void>
  watchFiles(paths: string[]): void
  searchInFolder(root: string, query: string, options: SearchOptions & ScanOptions): Promise<SearchFileResult[]>

  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): void
  openPath(path: string): Promise<string>
  copyText(text: string): void
  readClipboardText(): Promise<string>
  /** Native cut / copy / paste on the focused element (fires the real clipboard events). */
  editAction(action: 'cut' | 'copy' | 'paste'): void
  /** Put an image (data:, http(s): or asset URL) on the clipboard. */
  copyImage(src: string): Promise<void>
  setFullScreen(flag: boolean): void
  onFullScreen(cb: (full: boolean) => void): () => void
  /** A complete two-stroke shortcut, e.g. "Cmd+K Cmd+U". */
  onChord(cb: (key: string) => void): () => void
  /** The chord prefix while waiting for the second stroke, or null. */
  onChordPending(cb: (prefix: string | null) => void): () => void
  listHeadings(root: string, options: ScanOptions): Promise<HeadingEntry[]>

  setSettings(partial: Partial<Settings>): Promise<Settings>
  addRecent(path: string, kind: 'file' | 'folder'): void
  clearRecent(): void
  setSession(session: SessionState): void
  setDocumentState(state: { path: string | null; dirty: boolean; title: string }): void

  exportPDF(defaultPath: string): Promise<string | null>
  print(): Promise<boolean>
  setDefaultApp(): Promise<{ ok: boolean; message?: string; action?: 'windows-settings' }>

  writeBackup(entry: BackupEntry): Promise<void>
  deleteBackups(ids: string[]): Promise<void>
  /** Hand backups kept with "Keep for Next Time" to the next window that opens. */
  stashBackups(ids: string[]): Promise<void>

  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdateState(cb: (state: UpdateState) => void): () => void

  getPathForFile(file: File): string
  toAssetUrl(path: string): string
}
