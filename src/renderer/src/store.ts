import { create } from 'zustand'
import { DEFAULT_SETTINGS, type LineEnding, type Platform, type RecentItem, type Settings, type TextEncoding, type TreeNode, type ViewMode } from '@shared/types'
import type { Locale } from '@shared/i18n'
import type { UpdateState } from '@shared/update'
import type { Heading } from '@/markdown/md'

/** markdown / text open in the editor; image and binary files get a viewer instead. */
export type TabKind = 'markdown' | 'text' | 'image' | 'binary'

export interface Tab {
  id: string
  path: string | null
  name: string
  kind: TabKind
  content: string
  saved: string
  mtime: number
  externalChange: boolean
  deleted: boolean
  /** Built-in documents (e.g. the syntax guide) that are not backed by a file yet. */
  builtin?: boolean
  /** On-disk encoding and line endings, kept when saving (UTF-8 / LF when absent). */
  encoding?: TextEncoding
  eol?: LineEnding
  /** Line endings on disk; differs from `eol` after switching LF / CRLF until the next save. */
  savedEol?: LineEnding
  /** File size in bytes. */
  size?: number
  /** Binary view: the file is text but too large for the editor. */
  tooLarge?: boolean
  /**
   * Large-file mode: the text lives only in the editor (content / saved stay empty), changes are
   * tracked with `dirty`, and costly extras (preview, word count, crash snapshots…) are off.
   */
  large?: boolean
  /** Large file still streaming in: 0…1. */
  loading?: number
  dirty?: boolean
  /** Syntax chosen by the user for a text tab ('plain' = none); detected from the name otherwise. */
  language?: string
}

export type SidebarPanel = 'files' | 'outline' | 'search'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error' | 'success'
}

export interface ViewerContent {
  kind: 'svg' | 'image'
  /** SVG markup, or an image URL. */
  content: string
  /** Base file name used when exporting. */
  name: string
}

export interface RevealRequest {
  tabId: string
  line?: number
  column?: number
  length?: number
  anchor?: string
  seq: number
}

export interface AppState {
  ready: boolean
  platform: Platform
  version: string
  homeDir: string
  isPackaged: boolean
  systemLocale: string
  locale: Locale
  settings: Settings
  recent: RecentItem[]
  systemDark: boolean
  /** Forces the light theme while printing / exporting PDFs. */
  forceLight: boolean

  root: string | null
  tree: TreeNode | null
  expanded: Record<string, boolean>

  tabs: Tab[]
  activeId: string | null
  closedPaths: string[]

  viewMode: ViewMode
  lastEditMode: 'edit' | 'split'
  sidebarVisible: boolean
  sidebarPanel: SidebarPanel

  headings: Heading[]
  activeHeading: string | null
  cursor: { line: number; col: number; selected: number }
  /** Lines in the active editor document. */
  docLines: number

  /** Command palette: null when closed, else the initial query ('' files, ':' line, '@' headings, '#' folder headings, '>' commands). */
  palette: string | null
  /** Chord prefix waiting for its second key, e.g. "⌘K". */
  chordPending: string | null
  focusMode: boolean
  /** Seeds the preview find bar (⌘E / ⌘G in reading mode). */
  findSeed: { text: string; seq: number } | null
  settingsOpen: boolean
  settingsSection: string | null
  update: UpdateState | null
  findOpen: boolean
  aboutOpen: boolean
  searchFocusSeq: number
  toasts: Toast[]
  reveal: RevealRequest | null
  viewer: ViewerContent | null
}

export const useStore = create<AppState>(() => ({
  ready: false,
  platform: window.mf?.platform ?? 'darwin',
  version: '',
  homeDir: '',
  isPackaged: false,
  systemLocale: navigator.language,
  locale: 'zh-CN',
  settings: { ...DEFAULT_SETTINGS },
  recent: [],
  systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  forceLight: false,

  root: null,
  tree: null,
  expanded: {},

  tabs: [],
  activeId: null,
  closedPaths: [],

  viewMode: 'preview',
  lastEditMode: 'split',
  sidebarVisible: false,
  sidebarPanel: 'files',

  headings: [],
  activeHeading: null,
  cursor: { line: 1, col: 1, selected: 0 },
  docLines: 0,

  palette: null,
  chordPending: null,
  focusMode: false,
  findSeed: null,
  settingsOpen: false,
  settingsSection: null,
  update: null,
  findOpen: false,
  aboutOpen: false,
  searchFocusSeq: 0,
  toasts: [],
  reveal: null,
  viewer: null
}))

export const getState = useStore.getState
export const setState = useStore.setState

export function activeTab(state: AppState = getState()): Tab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null
}

/** Tabs whose content lives in the editor (as opposed to the image / binary viewers). */
export function isEditable(tab: Pick<Tab, 'kind'> | null | undefined): boolean {
  return !!tab && (tab.kind === 'markdown' || tab.kind === 'text')
}

/** A document that was never saved: there's no file yet, so its type is still open. */
export function isNewDocument(tab: Tab | null | undefined): boolean {
  return !!tab && isEditable(tab) && !tab.path && !tab.builtin
}

export function isDirty(tab: Tab): boolean {
  if (!isEditable(tab)) return false
  const eolChanged = tab.savedEol !== undefined && tab.eol !== tab.savedEol
  return eolChanged || (tab.large ? !!tab.dirty : tab.content !== tab.saved)
}

export function resolvedTheme(state: Pick<AppState, 'settings' | 'systemDark' | 'forceLight'>): 'light' | 'dark' {
  if (state.forceLight) return 'light'
  if (state.settings.theme === 'system') return state.systemDark ? 'dark' : 'light'
  return state.settings.theme
}

let toastSeq = 0
export function toast(message: string, kind: Toast['kind'] = 'info', timeout = 3200): void {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), timeout)
}

export function updateTab(id: string, patch: Partial<Tab>): void {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}
