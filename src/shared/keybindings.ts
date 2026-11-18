/**
 * Single source of truth for commands and keyboard shortcuts (Sublime Text 4 defaults,
 * adapted to MarkFlow). Menus, the CodeMirror keymap, the command palette and
 * docs/shortcuts.md are all generated from this table.
 *
 * Key notation is Electron's accelerator syntax with explicit modifiers:
 *   mac:   "Cmd+Shift+P", "Ctrl+Cmd+Up", chords "Cmd+K Cmd+U"
 *   other: "Ctrl+Shift+P", "Alt+F3",     chords "Ctrl+K Ctrl+U"
 *
 * Only type imports here, so Node can load this file directly (tests, doc generator).
 */
import type { MessageKey } from './i18n'
import type { MenuCommand, Platform } from './types'

export type CommandScope = 'editor' | 'global'

export interface CommandDef {
  id: MenuCommand
  /** i18n key for menus and the command palette. */
  label: MessageKey
  labelVars?: Record<string, string | number>
  /** Palette / docs grouping. */
  group: MessageKey
  scope: CommandScope
  mac?: string
  other?: string
  /** Shown in menus but left to the editor / OS (e.g. ⌘⌫), so no menu accelerator. */
  native?: boolean
  /** Extra shortcuts, handled by the renderer, not shown in menus. */
  alt?: { mac?: string[]; other?: string[] }
  /** Hide from the command palette. */
  hidden?: boolean
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

export const COMMANDS: CommandDef[] = [
  // ---- File
  { id: 'new-file', label: 'menu.newFile', group: 'menu.file', scope: 'global', mac: 'Cmd+N', other: 'Ctrl+N' },
  { id: 'new-window', label: 'menu.newWindow', group: 'menu.file', scope: 'global', mac: 'Shift+Cmd+N', other: 'Ctrl+Shift+N' },
  { id: 'open-file', label: 'menu.openFile', group: 'menu.file', scope: 'global', mac: 'Cmd+O', other: 'Ctrl+O' },
  { id: 'open-folder', label: 'menu.openFolder', group: 'menu.file', scope: 'global', mac: 'Shift+Cmd+O', other: 'Ctrl+Shift+O' },
  { id: 'close-folder', label: 'menu.closeFolder', group: 'menu.file', scope: 'global' },
  { id: 'save', label: 'menu.save', group: 'menu.file', scope: 'global', mac: 'Cmd+S', other: 'Ctrl+S' },
  { id: 'save-as', label: 'menu.saveAs', group: 'menu.file', scope: 'global', mac: 'Shift+Cmd+S', other: 'Ctrl+Shift+S' },
  { id: 'save-all', label: 'menu.saveAll', group: 'menu.file', scope: 'global', mac: 'Alt+Cmd+S', other: 'Ctrl+Alt+S' },
  { id: 'export-html', label: 'menu.exportHtml', group: 'menu.file', scope: 'global' },
  { id: 'export-pdf', label: 'menu.exportPdf', group: 'menu.file', scope: 'global' },
  { id: 'print', label: 'menu.print', group: 'menu.file', scope: 'global', mac: 'Alt+Cmd+P', other: 'Ctrl+Alt+P' },
  { id: 'close-tab', label: 'menu.closeTab', group: 'menu.file', scope: 'global', mac: 'Cmd+W', other: 'Ctrl+W' },
  { id: 'close-window', label: 'menu.closeWindow', group: 'menu.file', scope: 'global', mac: 'Shift+Cmd+W', other: 'Ctrl+Shift+W' },
  { id: 'reopen-closed-tab', label: 'menu.reopenTab', group: 'menu.file', scope: 'global', mac: 'Shift+Cmd+T', other: 'Ctrl+Shift+T' },
  { id: 'settings', label: 'menu.settings', group: 'menu.file', scope: 'global', mac: 'Cmd+,', other: 'Ctrl+,' },

  // ---- Edit
  { id: 'undo', label: 'menu.undo', group: 'menu.edit', scope: 'global', mac: 'Cmd+Z', other: 'Ctrl+Z' },
  { id: 'redo', label: 'menu.redo', group: 'menu.edit', scope: 'global', mac: 'Shift+Cmd+Z', other: 'Ctrl+Y' },
  { id: 'soft-undo', label: 'cmd.softUndo', group: 'menu.edit', scope: 'editor', mac: 'Cmd+U', other: 'Ctrl+U' },
  { id: 'select-all', label: 'menu.selectAll', group: 'menu.edit', scope: 'global', mac: 'Cmd+A', other: 'Ctrl+A' },
  { id: 'paste-indent', label: 'cmd.pasteIndent', group: 'menu.edit', scope: 'editor', mac: 'Shift+Cmd+V', other: 'Ctrl+Shift+V' },
  { id: 'indent', label: 'cmd.indent', group: 'cmd.groupLine', scope: 'editor', mac: 'Cmd+]', other: 'Ctrl+]' },
  { id: 'outdent', label: 'cmd.outdent', group: 'cmd.groupLine', scope: 'editor', mac: 'Cmd+[', other: 'Ctrl+[' },
  { id: 'swap-line-up', label: 'cmd.swapLineUp', group: 'cmd.groupLine', scope: 'editor', mac: 'Ctrl+Cmd+Up', other: 'Ctrl+Shift+Up' },
  { id: 'swap-line-down', label: 'cmd.swapLineDown', group: 'cmd.groupLine', scope: 'editor', mac: 'Ctrl+Cmd+Down', other: 'Ctrl+Shift+Down' },
  { id: 'duplicate-line', label: 'cmd.duplicateLine', group: 'cmd.groupLine', scope: 'editor', mac: 'Shift+Cmd+D', other: 'Ctrl+Shift+D' },
  { id: 'delete-line', label: 'cmd.deleteLine', group: 'cmd.groupLine', scope: 'editor', mac: 'Ctrl+Shift+K', other: 'Ctrl+Shift+K' },
  { id: 'join-lines', label: 'cmd.joinLines', group: 'cmd.groupLine', scope: 'editor', mac: 'Cmd+J', other: 'Ctrl+J' },
  { id: 'insert-line-after', label: 'cmd.insertLineAfter', group: 'cmd.groupText', scope: 'editor', mac: 'Cmd+Enter', other: 'Ctrl+Enter' },
  { id: 'insert-line-before', label: 'cmd.insertLineBefore', group: 'cmd.groupText', scope: 'editor', mac: 'Shift+Cmd+Enter', other: 'Ctrl+Shift+Enter' },
  { id: 'delete-to-eol', label: 'cmd.deleteToEol', group: 'cmd.groupText', scope: 'editor', mac: 'Cmd+K Cmd+K', other: 'Ctrl+K Ctrl+K' },
  { id: 'delete-to-bol', label: 'cmd.deleteToBol', group: 'cmd.groupText', scope: 'editor', mac: 'Cmd+Backspace', other: 'Ctrl+K Ctrl+Backspace', native: true },
  { id: 'toggle-comment', label: 'cmd.toggleComment', group: 'cmd.groupText', scope: 'editor', mac: 'Cmd+/', other: 'Ctrl+/' },
  { id: 'toggle-block-comment', label: 'cmd.toggleBlockComment', group: 'cmd.groupText', scope: 'editor', mac: 'Alt+Cmd+/', other: 'Ctrl+Shift+/' },
  { id: 'upper-case', label: 'cmd.upperCase', group: 'cmd.groupText', scope: 'editor', mac: 'Cmd+K Cmd+U', other: 'Ctrl+K Ctrl+U' },
  { id: 'lower-case', label: 'cmd.lowerCase', group: 'cmd.groupText', scope: 'editor', mac: 'Cmd+K Cmd+L', other: 'Ctrl+K Ctrl+L' },
  { id: 'sort-lines', label: 'cmd.sortLines', group: 'cmd.groupText', scope: 'editor', mac: 'F5', other: 'F9' },
  { id: 'sort-lines-case', label: 'cmd.sortLinesCase', group: 'cmd.groupText', scope: 'editor', mac: 'Ctrl+F5', other: 'Ctrl+F9' },
  { id: 'fold', label: 'cmd.fold', group: 'cmd.groupFold', scope: 'editor', mac: 'Alt+Cmd+[', other: 'Ctrl+Shift+[' },
  { id: 'unfold', label: 'cmd.unfold', group: 'cmd.groupFold', scope: 'editor', mac: 'Alt+Cmd+]', other: 'Ctrl+Shift+]' },
  { id: 'fold-all', label: 'cmd.foldAll', group: 'cmd.groupFold', scope: 'editor' },
  {
    id: 'unfold-all',
    label: 'cmd.unfoldAll',
    group: 'cmd.groupFold',
    scope: 'editor',
    mac: 'Cmd+K Cmd+0',
    other: 'Ctrl+K Ctrl+0',
    alt: { mac: ['Cmd+K Cmd+J'], other: ['Ctrl+K Ctrl+J'] }
  },
  ...range(9).map(
    (n): CommandDef => ({
      id: `fold-level-${n}` as MenuCommand,
      label: 'cmd.foldLevel',
      labelVars: { n },
      group: 'cmd.groupFold',
      scope: 'editor',
      mac: `Cmd+K Cmd+${n}`,
      other: `Ctrl+K Ctrl+${n}`,
      hidden: n > 6
    })
  ),

  // ---- Selection
  { id: 'split-into-lines', label: 'cmd.splitIntoLines', group: 'menu.selection', scope: 'editor', mac: 'Shift+Cmd+L', other: 'Ctrl+Shift+L' },
  { id: 'add-cursor-above', label: 'cmd.addCursorAbove', group: 'menu.selection', scope: 'editor', mac: 'Ctrl+Shift+Up', other: 'Ctrl+Alt+Up' },
  { id: 'add-cursor-below', label: 'cmd.addCursorBelow', group: 'menu.selection', scope: 'editor', mac: 'Ctrl+Shift+Down', other: 'Ctrl+Alt+Down' },
  { id: 'select-line', label: 'cmd.selectLine', group: 'menu.selection', scope: 'editor', mac: 'Cmd+L', other: 'Ctrl+L' },
  { id: 'expand-brackets', label: 'cmd.expandBrackets', group: 'menu.selection', scope: 'editor', mac: 'Ctrl+Shift+M', other: 'Ctrl+Shift+M' },
  { id: 'expand-indentation', label: 'cmd.expandIndentation', group: 'menu.selection', scope: 'editor', mac: 'Shift+Cmd+J', other: 'Ctrl+Shift+J' },
  { id: 'expand-scope', label: 'cmd.expandScope', group: 'menu.selection', scope: 'editor', mac: 'Shift+Cmd+Space', other: 'Ctrl+Shift+Space' },

  // ---- Find
  { id: 'find', label: 'menu.find', group: 'menu.findMenu', scope: 'global', mac: 'Cmd+F', other: 'Ctrl+F' },
  { id: 'find-next', label: 'cmd.findNext', group: 'menu.findMenu', scope: 'global', mac: 'Cmd+G', other: 'F3' },
  { id: 'find-prev', label: 'cmd.findPrev', group: 'menu.findMenu', scope: 'global', mac: 'Shift+Cmd+G', other: 'Shift+F3' },
  { id: 'replace', label: 'cmd.replace', group: 'menu.findMenu', scope: 'global', mac: 'Alt+Cmd+F', other: 'Ctrl+H' },
  { id: 'quick-find-next', label: 'cmd.quickFindNext', group: 'menu.findMenu', scope: 'editor', mac: 'Alt+Cmd+G', other: 'Ctrl+F3' },
  { id: 'select-all-occurrences', label: 'cmd.selectAllOccurrences', group: 'menu.findMenu', scope: 'editor', mac: 'Ctrl+Cmd+G', other: 'Alt+F3' },
  { id: 'select-next-occurrence', label: 'cmd.selectNextOccurrence', group: 'menu.findMenu', scope: 'editor', mac: 'Cmd+D', other: 'Ctrl+D' },
  { id: 'skip-occurrence', label: 'cmd.skipOccurrence', group: 'menu.findMenu', scope: 'editor', mac: 'Cmd+K Cmd+D', other: 'Ctrl+K Ctrl+D' },
  { id: 'use-selection-find', label: 'cmd.useSelectionFind', group: 'menu.findMenu', scope: 'global', mac: 'Cmd+E', other: 'Ctrl+E' },
  { id: 'search-in-folder', label: 'menu.searchInFolder', group: 'menu.findMenu', scope: 'global', mac: 'Shift+Cmd+F', other: 'Ctrl+Shift+F' },
  // Only active while a find field has focus; ⌥⌘C is shared with "code block" and resolved by context.
  { id: 'find-toggle-regex', label: 'cmd.findToggleRegex', group: 'menu.findMenu', scope: 'global', mac: 'Alt+Cmd+R', other: 'Alt+R', native: true },
  { id: 'find-toggle-case', label: 'cmd.findToggleCase', group: 'menu.findMenu', scope: 'global', mac: 'Alt+Cmd+C', other: 'Alt+C', native: true },
  { id: 'find-toggle-word', label: 'cmd.findToggleWord', group: 'menu.findMenu', scope: 'global', mac: 'Alt+Cmd+W', other: 'Alt+W', native: true },

  // ---- Goto
  { id: 'quick-open', label: 'menu.quickOpen', group: 'menu.goto', scope: 'global', mac: 'Cmd+P', other: 'Ctrl+P' },
  { id: 'command-palette', label: 'cmd.commandPalette', group: 'menu.goto', scope: 'global', mac: 'Shift+Cmd+P', other: 'Ctrl+Shift+P', hidden: true },
  { id: 'goto-heading', label: 'cmd.gotoHeading', group: 'menu.goto', scope: 'global', mac: 'Cmd+R', other: 'Ctrl+R' },
  { id: 'goto-heading-project', label: 'cmd.gotoHeadingProject', group: 'menu.goto', scope: 'global', mac: 'Shift+Cmd+R', other: 'Ctrl+Shift+R' },
  { id: 'goto-line', label: 'cmd.gotoLine', group: 'menu.goto', scope: 'global', mac: 'Ctrl+G', other: 'Ctrl+G' },
  { id: 'jump-back', label: 'cmd.jumpBack', group: 'menu.goto', scope: 'global', mac: 'Ctrl+-', other: 'Alt+-' },
  { id: 'jump-forward', label: 'cmd.jumpForward', group: 'menu.goto', scope: 'global', mac: 'Ctrl+Shift+-', other: 'Alt+Shift+-' },
  { id: 'jump-bracket', label: 'cmd.jumpBracket', group: 'menu.goto', scope: 'editor', mac: 'Ctrl+M', other: 'Ctrl+M' },
  {
    id: 'next-tab',
    label: 'menu.nextTab',
    group: 'menu.goto',
    scope: 'global',
    mac: 'Alt+Cmd+Right',
    other: 'Ctrl+PageDown',
    alt: { mac: ['Shift+Cmd+]', 'Ctrl+Tab'], other: ['Ctrl+Tab'] }
  },
  {
    id: 'prev-tab',
    label: 'menu.prevTab',
    group: 'menu.goto',
    scope: 'global',
    mac: 'Alt+Cmd+Left',
    other: 'Ctrl+PageUp',
    alt: { mac: ['Shift+Cmd+[', 'Ctrl+Shift+Tab'], other: ['Ctrl+Shift+Tab'] }
  },
  ...range(9).map(
    (n): CommandDef => ({
      id: `tab-${n}` as MenuCommand,
      label: 'cmd.selectTab',
      labelVars: { n },
      group: 'menu.goto',
      scope: 'global',
      mac: `Cmd+${n}`,
      other: `Alt+${n}`
    })
  ),
  { id: 'bookmark-toggle', label: 'cmd.bookmarkToggle', group: 'cmd.groupBookmarks', scope: 'global', mac: 'Cmd+F2', other: 'Ctrl+F2' },
  { id: 'bookmark-next', label: 'cmd.bookmarkNext', group: 'cmd.groupBookmarks', scope: 'global', mac: 'F2', other: 'F2' },
  { id: 'bookmark-prev', label: 'cmd.bookmarkPrev', group: 'cmd.groupBookmarks', scope: 'global', mac: 'Shift+F2', other: 'Shift+F2' },
  { id: 'bookmark-clear', label: 'cmd.bookmarkClear', group: 'cmd.groupBookmarks', scope: 'global', mac: 'Shift+Cmd+F2', other: 'Ctrl+Shift+F2' },

  // ---- View
  {
    id: 'toggle-sidebar',
    label: 'menu.toggleSidebar',
    group: 'menu.view',
    scope: 'global',
    mac: 'Cmd+\\',
    other: 'Ctrl+\\',
    alt: { mac: ['Cmd+K Cmd+B'], other: ['Ctrl+K Ctrl+B'] }
  },
  { id: 'show-files', label: 'menu.files', group: 'menu.view', scope: 'global', mac: 'Shift+Cmd+E', other: 'Ctrl+Shift+E' },
  { id: 'show-outline', label: 'menu.outline', group: 'menu.view', scope: 'global' },
  { id: 'view-preview', label: 'menu.previewMode', group: 'menu.view', scope: 'global', mac: 'Alt+Cmd+1', other: 'Ctrl+Alt+1', alt: { other: ['Alt+Shift+1'] } },
  { id: 'view-edit', label: 'menu.editMode', group: 'menu.view', scope: 'global', mac: 'Alt+Cmd+2', other: 'Ctrl+Alt+2', alt: { other: ['Alt+Shift+2'] } },
  { id: 'view-split', label: 'menu.splitMode', group: 'menu.view', scope: 'global', mac: 'Alt+Cmd+3', other: 'Ctrl+Alt+3', alt: { other: ['Alt+Shift+3'] } },
  { id: 'toggle-view', label: 'menu.toggleView', group: 'menu.view', scope: 'global', mac: 'Alt+Cmd+E', other: 'Ctrl+Alt+E' },
  { id: 'focus-mode', label: 'cmd.focusMode', group: 'menu.view', scope: 'global', mac: 'Ctrl+Shift+Cmd+F', other: 'Shift+F11' },
  { id: 'theme-system', label: 'cmd.themeSystem', group: 'menu.view', scope: 'global' },
  { id: 'theme-light', label: 'cmd.themeLight', group: 'menu.view', scope: 'global' },
  { id: 'theme-dark', label: 'cmd.themeDark', group: 'menu.view', scope: 'global' },

  // ---- Format (Markdown)
  { id: 'format-bold', label: 'menu.bold', group: 'menu.format', scope: 'editor', mac: 'Cmd+B', other: 'Ctrl+B' },
  { id: 'format-italic', label: 'menu.italic', group: 'menu.format', scope: 'editor', mac: 'Cmd+I', other: 'Ctrl+I' },
  { id: 'format-strike', label: 'menu.strike', group: 'menu.format', scope: 'editor', mac: 'Shift+Cmd+X', other: 'Ctrl+Shift+X' },
  { id: 'format-code', label: 'menu.code', group: 'menu.format', scope: 'editor', mac: 'Ctrl+`', other: 'Ctrl+`' },
  { id: 'format-link', label: 'menu.link', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+K', other: 'Ctrl+Alt+K' },
  { id: 'format-image', label: 'menu.image', group: 'menu.format', scope: 'editor' },
  ...range(6).map(
    (n): CommandDef => ({
      id: `format-h${n}` as MenuCommand,
      label: 'menu.heading',
      labelVars: { n },
      group: 'menu.format',
      scope: 'editor',
      mac: `Ctrl+Cmd+${n}`,
      other: `Ctrl+${n}`
    })
  ),
  { id: 'format-quote', label: 'menu.quote', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+Q', other: 'Ctrl+Alt+Q' },
  { id: 'format-ul', label: 'menu.ul', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+U', other: 'Ctrl+Alt+U' },
  { id: 'format-ol', label: 'menu.ol', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+O', other: 'Ctrl+Alt+O' },
  { id: 'format-task', label: 'menu.task', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+X', other: 'Ctrl+Alt+X' },
  { id: 'format-codeblock', label: 'menu.codeblock', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+C', other: 'Ctrl+Alt+C' },
  { id: 'format-table', label: 'menu.table', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+T', other: 'Ctrl+Alt+T' },
  { id: 'format-math', label: 'menu.math', group: 'menu.format', scope: 'editor', mac: 'Alt+Cmd+B', other: 'Ctrl+Alt+B' },
  { id: 'format-hr', label: 'menu.hr', group: 'menu.format', scope: 'editor' },

  // ---- Misc (palette only)
  { id: 'markdown-guide', label: 'menu.guide', group: 'menu.help', scope: 'global' },
  { id: 'check-updates', label: 'menu.checkUpdates', group: 'menu.help', scope: 'global' },
  { id: 'about', label: 'menu.about', group: 'menu.help', scope: 'global' }
]

export const COMMAND_MAP = new Map<MenuCommand, CommandDef>(COMMANDS.map((c) => [c.id, c]))

export const isMacPlatform = (p: Platform | string): boolean => p === 'darwin'

/** Primary shortcut of a command on a platform. */
export function keyOf(id: MenuCommand, platform: Platform | string): string | undefined {
  const def = COMMAND_MAP.get(id)
  return def ? (isMacPlatform(platform) ? def.mac : def.other) : undefined
}

/** Every shortcut (primary + alternates) of a command on a platform. */
export function keysOf(def: CommandDef, platform: Platform | string): string[] {
  const mac = isMacPlatform(platform)
  const primary = mac ? def.mac : def.other
  const extra = (mac ? def.alt?.mac : def.alt?.other) ?? []
  return [...(primary ? [primary] : []), ...extra]
}

export const isChord = (key: string): boolean => key.includes(' ')

export function chordPrefix(platform: Platform | string): string {
  return isMacPlatform(platform) ? 'Cmd+K' : 'Ctrl+K'
}

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const

/** Canonical form of one stroke ("Shift+Cmd+p" → "Shift+Cmd+P") so strings can be compared. */
export function normalizeStroke(stroke: string): string {
  const parts = stroke.split('+')
  // "Ctrl++" style is not used; "-" and "=" are plain keys.
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((m) => (m === 'Command' || m === 'Meta' ? 'Cmd' : m === 'Option' ? 'Alt' : m === 'Control' ? 'Ctrl' : m)))
  const ordered = MOD_ORDER.filter((m) => mods.has(m))
  const k = key.length === 1 ? key.toUpperCase() : key
  return [...ordered, k].join('+')
}

export function normalizeKey(key: string): string {
  return key.split(' ').map(normalizeStroke).join(' ')
}

const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Slash: '/',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: 'Space',
  Tab: 'Tab',
  Escape: 'Escape',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End'
}

export interface KeyLike {
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * Stroke for a keyboard event, based on the physical key (event.code) so that ⌥ / Shift
 * variants of characters still match. Returns null for modifier-only presses.
 */
export function strokeFromEvent(e: KeyLike, platform: Platform | string): string | null {
  let key: string | undefined
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  else key = CODE_KEYS[code]
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey && isMacPlatform(platform)) mods.push('Cmd')
  return [...mods, key].join('+')
}

/** Electron accelerator for a single-stroke key (chords have none). */
export function toAccelerator(key: string | undefined): string | undefined {
  if (!key || isChord(key)) return undefined
  return key
}

const CM_KEYS: Record<string, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Space: 'Space',
  Enter: 'Enter'
}

/** CodeMirror key name for a single stroke ("Shift+Cmd+D" → "Shift-Meta-d"). */
export function toCodeMirrorKey(key: string): string {
  const parts = normalizeStroke(key).split('+')
  const k = parts.pop()!
  const mods = parts.map((m) => (m === 'Cmd' ? 'Meta' : m))
  const name = CM_KEYS[k] ?? (k.length === 1 ? k.toLowerCase() : k)
  return [...mods, name].join('-')
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }
const MAC_KEYS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Tab: '⇥',
  PageUp: '⇞',
  PageDown: '⇟',
  Space: 'Space'
}

/** Human readable shortcut: "⇧⌘P" on macOS, "Ctrl+Shift+P" elsewhere. */
export function displayKey(key: string | undefined, platform: Platform | string): string {
  if (!key) return ''
  const mac = isMacPlatform(platform)
  return normalizeKey(key)
    .split(' ')
    .map((stroke) => {
      const parts = stroke.split('+')
      const k = parts.pop()!
      if (!mac) return [...parts, k].join('+')
      return parts.map((m) => MAC_SYMBOLS[m] ?? m).join('') + (MAC_KEYS[k] ?? k)
    })
    .join(' ')
}

/** Look up the command bound to a full key (single stroke or chord) on a platform. */
export function commandForKey(key: string, platform: Platform | string): MenuCommand | undefined {
  const wanted = normalizeKey(key)
  for (const def of COMMANDS) {
    for (const k of keysOf(def, platform)) if (normalizeKey(k) === wanted) return def.id
  }
  return undefined
}

/** Shortcuts the renderer must handle itself (alternates and chords; menus do the rest). */
export function rendererOnlyKeys(platform: Platform | string): { key: string; command: MenuCommand }[] {
  const out: { key: string; command: MenuCommand }[] = []
  const mac = isMacPlatform(platform)
  for (const def of COMMANDS) {
    for (const k of (mac ? def.alt?.mac : def.alt?.other) ?? []) if (!isChord(k)) out.push({ key: k, command: def.id })
  }
  return out
}
