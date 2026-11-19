/**
 * Right-click menu of the source editor (and of the inline block editor in reading mode):
 * clipboard, Markdown formatting, and actions for what was clicked — a link, an image,
 * a heading, a task or a fenced code block.
 */
import type { Extension, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { selectAll } from '@codemirror/commands'
import { language, syntaxTree } from '@codemirror/language'
import { followLink, openFile, openWikilink, searchInFolderFor } from '@/actions'
import { openContextMenu, type MenuItem } from '@/components/ContextMenu'
import { t } from '@/lib/i18n'
import { dirname, isAbsolute, resolve } from '@/lib/path'
import { slugify } from '@/markdown/md'
import { activeTab, getState, toast } from '@/store'
import { plainHeadingText } from '@shared/headings'
import { displayKey, keyOf } from '@shared/keybindings'
import { toAssetUrl } from '@shared/constants'
import type { MenuCommand } from '@shared/types'
import { editorBridge } from './bridge'
import { runFormat, setHeading, type FormatCommand } from './commands'
import { editorCommand } from './keymap'

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

/* ------------------------------------------------------------------ */
/* Shortcuts                                                           */
/* ------------------------------------------------------------------ */

const platform = () => getState().platform

export function shortcutOf(id: MenuCommand): string | undefined {
  return displayKey(keyOf(id, platform()), platform()) || undefined
}

/** ⌘X / Ctrl+X style label for the clipboard keys, which the OS menu roles own. */
export function clipboardKey(letter: 'X' | 'C' | 'V' | 'A'): string {
  const p = platform()
  return displayKey(p === 'darwin' ? `Cmd+${letter}` : `Ctrl+${letter}`, p)
}

/* ------------------------------------------------------------------ */
/* What was clicked                                                    */
/* ------------------------------------------------------------------ */

interface Range {
  from: number
  to: number
}

interface LinkInfo {
  href: string
  /** Range of the address in the source, to select it for editing. */
  url: Range | null
}

interface CodeInfo {
  code: string
  lang: string
  /** Where the info string is, or where it goes after the opening fence. */
  info: Range
}

interface Context {
  link?: LinkInfo
  wikilink?: string
  image?: LinkInfo
  heading?: { line: number; level: number; text: string }
  task?: { line: number; done: boolean }
  code?: CodeInfo
}

function unwrapUrl(url: string): string {
  return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url
}

function linkInfo(state: EditorState, node: SyntaxNode): LinkInfo | null {
  const url = node.name === 'URL' ? node : node.getChild('URL')
  if (!url) return null
  return { href: unwrapUrl(state.sliceDoc(url.from, url.to)), url: { from: url.from, to: url.to } }
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/

function codeInfo(state: EditorState, node: SyntaxNode): CodeInfo {
  const doc = state.doc
  const open = doc.lineAt(node.from)
  const close = doc.lineAt(node.to)
  const closed = close.number > open.number && FENCE.test(close.text) && !close.text.replace(FENCE, '').trim()
  const lines: string[] = []
  for (let n = open.number + 1; n <= (closed ? close.number - 1 : close.number); n++) lines.push(doc.line(n).text)
  const infoNode = node.getChild('CodeInfo')
  const mark = node.getChild('CodeMark')
  const info = infoNode ? { from: infoNode.from, to: infoNode.to } : { from: mark?.to ?? open.to, to: mark?.to ?? open.to }
  return { code: lines.join('\n'), lang: infoNode ? state.sliceDoc(infoNode.from, infoNode.to).trim() : '', info }
}

const TASK = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

function contextAt(state: EditorState, pos: number): Context {
  const ctx: Context = {}
  const tree = syntaxTree(state)
  let inCode = false
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const name = node.name
      if (name === 'Image') ctx.image ??= linkInfo(state, node) ?? undefined
      else if (name === 'Link' || name === 'Autolink') ctx.link ??= linkInfo(state, node) ?? undefined
      else if (name === 'URL' && !ctx.link && !ctx.image && !['Link', 'Image', 'Autolink'].includes(node.parent?.name ?? '')) {
        ctx.link = linkInfo(state, node) ?? undefined
      } else if (name === 'FencedCode') {
        inCode = true
        ctx.code ??= codeInfo(state, node)
      } else if (name === 'CodeBlock' || name === 'HTMLBlock' || name === 'CommentBlock') inCode = true
      else if (!ctx.heading) {
        const m = /^(?:ATX|Setext)Heading(\d)$/.exec(name)
        if (m) {
          const line = state.doc.lineAt(node.from)
          const text = name.startsWith('ATX') ? line.text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '') : line.text.trim()
          ctx.heading = { line: line.number, level: Number(m[1]), text }
        }
      }
    }
  }
  if (inCode) return { code: ctx.code }
  const line = state.doc.lineAt(pos)
  const task = TASK.exec(line.text)
  if (task) ctx.task = { line: line.number, done: task[2] !== ' ' }
  // [[Wikilinks]] are not part of the Markdown grammar.
  for (const m of line.text.matchAll(WIKILINK)) {
    const from = line.from + m.index!
    if (pos >= from && pos <= from + m[0].length) ctx.wikilink = m[1].trim()
  }
  return ctx
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function copy(text: string): void {
  window.mf.copyText(text)
  toast(t('toast.copied'), 'success', 1500)
}

function selectRange(view: EditorView, r: Range): void {
  view.dispatch({ selection: { anchor: r.from, head: r.to }, scrollIntoView: true })
  view.focus()
}

const isRemote = (href: string) => /^(https?:)?\/\//i.test(href) || /^data:/i.test(href)

/** Absolute path of a local image / link target, or null when it can't be resolved. */
function localPath(href: string): string | null {
  if (isRemote(href) || /^[a-z][a-z0-9+.-]*:/i.test(href.replace(/^[a-zA-Z]:[\\/]/, ''))) return null
  let path = href.replace(/[?#].*$/, '')
  try {
    path = decodeURI(path)
  } catch {
    /* keep */
  }
  if (isAbsolute(path)) return path
  const tab = activeTab()
  const base = tab?.path ? dirname(tab.path) : getState().root
  return base ? resolve(base, path) : null
}

function imageSrc(href: string): string | null {
  if (isRemote(href)) return href.startsWith('//') ? `https:${href}` : href
  const path = localPath(href)
  return path ? toAssetUrl(path) : null
}

export async function copyImage(src: string): Promise<void> {
  try {
    await window.mf.copyImage(src)
    toast(t('toast.copied'), 'success', 1500)
  } catch (e) {
    toast(t('ctx.copyImageFailed', { msg: String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }), 'error')
  }
}

export function revealLabel(): string {
  const p = platform()
  return t(p === 'darwin' ? 'ctx.reveal.darwin' : p === 'win32' ? 'ctx.reveal.win32' : 'ctx.reveal.linux')
}

/** Anchor of a heading: the id the preview gave it when known, else the slug of its text. */
function headingAnchor(view: EditorView, heading: NonNullable<Context['heading']>): string {
  if (view === editorBridge.view) {
    const known = getState().headings.find((h) => h.line === heading.line - 1 && h.level === heading.level)
    if (known?.id) return known.id
  }
  return slugify(plainHeadingText(heading.text))
}

function toggleTask(view: EditorView, lineNo: number): void {
  const line = view.state.doc.line(lineNo)
  const m = TASK.exec(line.text)
  if (!m) return
  const at = line.from + m[1].length + 1
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.format' })
  view.focus()
}

const CODE_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'bash',
  'json',
  'yaml',
  'html',
  'css',
  'sql',
  'markdown',
  'mermaid',
  'plantuml'
]

function setCodeLanguage(view: EditorView, code: CodeInfo, lang: string): void {
  view.dispatch({ changes: { from: code.info.from, to: code.info.to, insert: lang }, userEvent: 'input.format' })
  view.focus()
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

function contextItems(view: EditorView, ctx: Context): MenuItem[] {
  const items: MenuItem[] = []
  if (ctx.image) {
    const { href, url } = ctx.image
    const src = imageSrc(href)
    const path = localPath(href)
    const web = src && /^https?:/i.test(src) ? src : null
    items.push(
      {
        label: t('ctx.openImage'),
        disabled: !path && !web,
        onClick: () => {
          if (path) void openFile(path)
          else if (web) void window.mf.openExternal(web)
        }
      },
      { label: t('ctx.copyImage'), disabled: !src, onClick: () => src && void copyImage(src) },
      { label: t('ctx.copyImageAddress'), onClick: () => copy(path ?? href) },
      ...(path ? [{ label: revealLabel(), onClick: () => window.mf.showItemInFolder(path) }] : []),
      ...(url ? [{ label: t('ctx.editImageAddress'), onClick: () => selectRange(view, url) }] : []),
      { separator: true }
    )
  }
  if (ctx.link) {
    const { href, url } = ctx.link
    items.push(
      { label: t('ctx.openLink'), onClick: () => void followLink(href).catch((e) => toast(String(e?.message ?? e), 'error')) },
      { label: t('ctx.copyLink'), onClick: () => copy(href) },
      ...(url ? [{ label: t('ctx.editLink'), onClick: () => selectRange(view, url) }] : []),
      { separator: true }
    )
  }
  if (ctx.wikilink) {
    const target = ctx.wikilink
    items.push({ label: t('ctx.openPage', { name: target }), onClick: () => void openWikilink(target) }, { separator: true })
  }
  if (ctx.heading) {
    const heading = ctx.heading
    items.push(
      { label: t('ctx.copyAnchor'), onClick: () => copy(`#${headingAnchor(view, heading)}`) },
      {
        label: t('ctx.foldSection'),
        shortcut: shortcutOf('fold'),
        onClick: () => {
          view.dispatch({ selection: { anchor: view.state.doc.line(heading.line).to } })
          editorCommand('fold', view)
        }
      },
      { separator: true }
    )
  }
  if (ctx.task) {
    const task = ctx.task
    items.push({ label: t(task.done ? 'ctx.taskUndone' : 'ctx.taskDone'), onClick: () => toggleTask(view, task.line) }, { separator: true })
  }
  if (ctx.code) {
    const code = ctx.code
    const langs = code.lang && !CODE_LANGUAGES.includes(code.lang) ? [code.lang, ...CODE_LANGUAGES] : CODE_LANGUAGES
    items.push(
      { label: t('ctx.copyCode'), onClick: () => copy(code.code) },
      {
        label: t('ctx.codeLanguage'),
        submenu: [
          { label: t('ctx.noLanguage'), checked: !code.lang, onClick: () => setCodeLanguage(view, code, '') },
          { separator: true },
          ...langs.map((lang) => ({ label: lang, checked: lang === code.lang, onClick: () => setCodeLanguage(view, code, lang) }))
        ]
      },
      { separator: true }
    )
  }
  return items
}

function clipboardItems(view: EditorView): MenuItem[] {
  const edit = (action: 'cut' | 'copy' | 'paste') => () => {
    view.focus()
    window.mf.editAction(action)
  }
  const readOnly = view.state.readOnly
  return [
    { label: t('menu.cut'), shortcut: clipboardKey('X'), disabled: readOnly, onClick: edit('cut') },
    { label: t('menu.copy'), shortcut: clipboardKey('C'), onClick: edit('copy') },
    { label: t('menu.paste'), shortcut: clipboardKey('V'), disabled: readOnly, onClick: edit('paste') },
    { label: t('cmd.pasteIndent'), shortcut: shortcutOf('paste-indent'), disabled: readOnly, onClick: () => editorCommand('paste-indent', view) },
    { label: t('menu.selectAll'), shortcut: clipboardKey('A'), onClick: () => selectAll(view) }
  ]
}

function lineKind(text: string): string {
  const h = /^\s{0,3}(#{1,6})(\s|$)/.exec(text)
  if (h) return `h${h[1].length}`
  if (/^\s*>/.test(text)) return 'quote'
  if (/^\s*[-*+]\s+\[[ xX]\](\s|$)/.test(text)) return 'task'
  if (/^\s*[-*+]\s/.test(text)) return 'ul'
  if (/^\s*\d+[.)]\s/.test(text)) return 'ol'
  return 'body'
}

function formatItems(view: EditorView): MenuItem[] {
  const fmt = (cmd: FormatCommand, label: string): MenuItem => ({
    label,
    shortcut: shortcutOf(`format-${cmd}` as MenuCommand),
    onClick: () => runFormat(view, cmd)
  })
  const kind = lineKind(view.state.doc.lineAt(view.state.selection.main.head).text)
  const para = (cmd: FormatCommand, label: string): MenuItem => ({ ...fmt(cmd, label), checked: kind === cmd })
  return [
    {
      label: t('menu.format'),
      submenu: [
        fmt('bold', t('menu.bold')),
        fmt('italic', t('menu.italic')),
        fmt('strike', t('menu.strike')),
        fmt('code', t('menu.code')),
        { separator: true },
        fmt('link', t('menu.link')),
        fmt('image', t('menu.image'))
      ]
    },
    {
      label: t('ctx.paragraph'),
      submenu: [
        {
          label: t('ctx.bodyText'),
          checked: kind === 'body',
          onClick: () => {
            if (kind.startsWith('h')) setHeading(view, Number(kind.slice(1)))
            else if (kind !== 'body') runFormat(view, kind as FormatCommand)
          }
        },
        ...[1, 2, 3, 4, 5, 6].map((n) => para(`h${n}` as FormatCommand, t('menu.heading', { n }))),
        { separator: true },
        para('quote', t('menu.quote')),
        para('ul', t('menu.ul')),
        para('ol', t('menu.ol')),
        para('task', t('menu.task'))
      ]
    },
    {
      label: t('ctx.insert'),
      submenu: [
        fmt('codeblock', t('menu.codeblock')),
        fmt('table', t('menu.table')),
        fmt('math', t('menu.math')),
        fmt('hr', t('menu.hr'))
      ]
    }
  ]
}

function searchItems(view: EditorView, markdown: boolean): MenuItem[] {
  const sel = view.state.selection.main
  const text = view.state.sliceDoc(sel.from, sel.to)
  const items: MenuItem[] = []
  if (!markdown) items.push({ label: t('cmd.toggleComment'), shortcut: shortcutOf('toggle-comment'), onClick: () => editorCommand('toggle-comment', view) })
  items.push({
    label: t('cmd.selectAllOccurrences'),
    shortcut: shortcutOf('select-all-occurrences'),
    onClick: () => editorCommand('select-all-occurrences', view)
  })
  if (text.trim() && !text.includes('\n') && getState().root) {
    const shown = text.length > 24 ? `${text.slice(0, 24)}…` : text
    items.push({ label: t('ctx.searchFolder', { text: shown }), onClick: () => searchInFolderFor(text) })
  }
  return items
}

export function editorMenuItems(view: EditorView, pos: number): MenuItem[] {
  const markdown = view.state.facet(language)?.name === 'markdown'
  const ctx = markdown ? contextAt(view.state, pos) : {}
  return [
    ...contextItems(view, ctx),
    ...clipboardItems(view),
    { separator: true },
    ...(markdown && !view.state.readOnly ? [...formatItems(view), { separator: true }] : []),
    ...searchItems(view, markdown)
  ]
}

/** Shows the menu on right-click; a click outside the selection moves the cursor there first. */
export const editorContextMenu: Extension = EditorView.domEventHandlers({
  mousedown(event) {
    // Keep the selection: the browser would otherwise select the word under a right-click.
    const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey && platform() === 'darwin')
    if (!secondary) return false
    event.preventDefault()
    return true
  },
  contextmenu(event, view) {
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    let pos = fromKeyboard ? null : view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos !== null) {
      const inside = view.state.selection.ranges.some((r) => !r.empty && pos! >= r.from && pos! <= r.to)
      if (!inside) view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' })
    } else pos = view.state.selection.main.head
    view.focus()
    let at = { clientX: event.clientX, clientY: event.clientY }
    if (fromKeyboard) {
      const c = view.coordsAtPos(pos)
      if (c) at = { clientX: c.left, clientY: c.bottom }
    }
    openContextMenu(
      { ...at, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() },
      editorMenuItems(view, pos)
    )
    return true
  }
})
