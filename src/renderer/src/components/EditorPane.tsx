import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  Bold,
  Code,
  Heading,
  Image,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Sigma,
  SquareCode,
  Strikethrough,
  Table
} from 'lucide-react'
import { openFile, updateContent } from '@/actions'
import { editorBridge } from '@/editor/bridge'
import type { FormatCommand } from '@/editor/commands'
import { editorContextMenu } from '@/editor/contextMenu'
import { markdownPaste } from '@/editor/paste'
import { createEditorState, settingsEffects, tabLanguageExtension } from '@/editor/setup'
import { t, useT } from '@/lib/i18n'
import { basename, dirname, isAbsolute, relative } from '@/lib/path'
import { isNavigating, recordJumpFromLine } from '@/lib/navHistory'
import { onEditorScroll, setDriver } from '@/lib/scrollSync'
import { activeTab, getState, isEditable, setState, toast, updateTab, useStore, type Tab } from '@/store'
import { largeDocs } from '@/lib/largeFile'
import { isImageFile } from '@shared/constants'

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function linkTarget(rel: string): string {
  const p = rel.replace(/\\/g, '/')
  return /[\s()<>]/.test(p) ? `<${p}>` : p
}

function insertText(view: EditorView, text: string, pos?: number): void {
  const at = pos ?? view.state.selection.main.from
  const to = pos ?? view.state.selection.main.to
  view.dispatch({ changes: { from: at, to, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.paste' })
  view.focus()
}

async function saveImages(view: EditorView, files: File[], pos?: number): Promise<void> {
  const tab = activeTab()
  if (!tab?.path) {
    toast(t('toast.needSaveForImage'), 'error')
    return
  }
  const docDir = dirname(tab.path)
  const folder = getState().settings.imageFolder.trim() || 'assets'
  const dir = isAbsolute(folder) ? folder : `${docDir}/${folder}`.replace(/\\/g, '/')
  const parts: string[] = []
  for (const file of files) {
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/gi, '')
    const generic = !file.name || /^image\.(png|jpe?g|gif)$/i.test(file.name)
    const name = generic ? `image-${timestamp()}.${ext}` : file.name
    try {
      const saved = await window.mf.saveImage(dir, name, await file.arrayBuffer())
      const rel = relative(docDir, saved)
      parts.push(`![${basename(saved).replace(/\.[^.]+$/, '')}](${linkTarget(rel)})`)
    } catch (e) {
      toast(String((e as Error).message), 'error')
    }
  }
  if (parts.length) insertText(view, parts.join('\n'), pos)
}

// Tables from spreadsheets become Markdown tables; real image pastes are saved next to the document.
const pasteHandler = markdownPaste((view, files) => void saveImages(view, files))

const editorEvents = EditorView.domEventHandlers({
  drop(event, view) {
    const files = [...(event.dataTransfer?.files ?? [])]
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined
    // Files dragged from the sidebar tree arrive as plain text paths.
    if (!files.length) {
      const text = event.dataTransfer?.getData('text/plain') ?? ''
      const tab = activeTab()
      if (tab?.path && isAbsolute(text) && !text.includes('\n')) {
        event.preventDefault()
        const rel = linkTarget(relative(dirname(tab.path), text))
        const label = basename(text).replace(/\.[^.]+$/, '')
        insertText(view, isImageFile(text) ? `![${label}](${rel})` : `[${label}](${rel})`, pos)
        return true
      }
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    const tab = activeTab()
    const withPath = files.map((f) => ({ file: f, path: window.mf.getPathForFile(f) }))
    // Images dropped on a Markdown document are inserted; every other file (or any file on a
    // code / text document) is opened in its own tab.
    const images =
      tab?.kind === 'markdown' ? withPath.filter((x) => x.file.type.startsWith('image/') || isImageFile(x.file.name)) : []
    for (const d of withPath) if (d.path && !images.includes(d)) void openFile(d.path)
    if (!images.length) return true
    if (tab?.path && images.every((x) => x.path)) {
      const text = images
        .map((x) => `![${basename(x.path).replace(/\.[^.]+$/, '')}](${linkTarget(relative(dirname(tab.path!), x.path))})`)
        .join('\n')
      insertText(view, text, pos)
    } else {
      void saveImages(
        view,
        images.map((x) => x.file),
        pos
      )
    }
    return true
  },
  scroll() {
    onEditorScroll()
    return false
  }
})

const listeners = EditorView.updateListener.of((update) => {
  const id = editorBridge.currentTabId
  if (!id) return
  if (update.docChanged) {
    const tab = getState().tabs.find((x) => x.id === id)
    // Large files: just remember that something changed (no copy of hundreds of MB per keystroke).
    if (tab?.large) {
      if (!tab.dirty) updateTab(id, { dirty: true })
    } else updateContent(id, update.state.doc.toString())
    if (update.state.doc.lines !== update.startState.doc.lines) setState({ docLines: update.state.doc.lines })
  }
  if (update.docChanged || update.selectionSet) {
    const sel = update.state.selection.main
    const line = update.state.doc.lineAt(sel.head)
    // Big cursor moves (clicks, ⌘↑, bookmarks…) are remembered for jump back (⌃-).
    if (!update.docChanged && !isNavigating()) {
      const before = update.startState.doc.lineAt(update.startState.selection.main.head).number
      if (Math.abs(line.number - before) >= 10) recordJumpFromLine(before - 1)
    }
    setState({ cursor: { line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from) } })
  }
})

function makeState(tab: Tab): EditorState {
  // A large file's text was streamed straight into a document (see lib/largeFile.ts).
  const doc = tab.large ? (largeDocs.get(tab.id) ?? '') : tab.content
  largeDocs.delete(tab.id)
  const language = tabLanguageExtension(tab, tab.large ? '' : tab.content, (ext) => editorBridge.setLanguage(tab.id, ext))
  return createEditorState(doc, language, getState().settings, { extensions: [listeners, pasteHandler, editorEvents, editorContextMenu] }, { large: tab.large })
}

interface ToolItem {
  cmd: FormatCommand
  icon: React.ReactNode
  label: Parameters<typeof t>[0]
}

const TOOLS: (ToolItem | null)[] = [
  { cmd: 'h2', icon: <Heading size={16} />, label: 'toolbar.heading' },
  { cmd: 'bold', icon: <Bold size={16} />, label: 'toolbar.bold' },
  { cmd: 'italic', icon: <Italic size={16} />, label: 'toolbar.italic' },
  { cmd: 'strike', icon: <Strikethrough size={16} />, label: 'toolbar.strike' },
  null,
  { cmd: 'quote', icon: <Quote size={16} />, label: 'toolbar.quote' },
  { cmd: 'ul', icon: <List size={16} />, label: 'toolbar.ul' },
  { cmd: 'ol', icon: <ListOrdered size={16} />, label: 'toolbar.ol' },
  { cmd: 'task', icon: <ListChecks size={16} />, label: 'toolbar.task' },
  null,
  { cmd: 'code', icon: <Code size={16} />, label: 'toolbar.code' },
  { cmd: 'codeblock', icon: <SquareCode size={16} />, label: 'toolbar.codeblock' },
  { cmd: 'link', icon: <Link size={16} />, label: 'toolbar.link' },
  { cmd: 'image', icon: <Image size={16} />, label: 'toolbar.image' },
  { cmd: 'table', icon: <Table size={16} />, label: 'toolbar.table' },
  { cmd: 'math', icon: <Sigma size={16} />, label: 'toolbar.math' },
  { cmd: 'hr', icon: <Minus size={16} />, label: 'toolbar.hr' }
]

export function EditorToolbar() {
  const tr = useT()
  return (
    <div className="editor-toolbar" onMouseDown={(e) => e.preventDefault()}>
      {TOOLS.map((item, i) =>
        item ? (
          <button key={item.cmd} title={tr(item.label)} onClick={() => editorBridge.format(item.cmd)}>
            {item.icon}
          </button>
        ) : (
          <span key={i} className="toolbar-sep" />
        )
      )}
    </div>
  )
}

export function EditorPane({ visible }: { visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tabId = useStore((s) => s.activeId)
  const tabKind = useStore((s) => activeTab(s)?.kind)
  const tabName = useStore((s) => activeTab(s)?.name)
  const tabLanguage = useStore((s) => activeTab(s)?.language)
  const tabLoading = useStore((s) => activeTab(s)?.loading !== undefined)
  const settings = useStore((s) => s.settings)
  const reveal = useStore((s) => s.reveal)
  const handledReveal = useRef(0)

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: EditorState.create({ doc: '' }) })
    editorBridge.view = view
    editorBridge.makeState = makeState
    editorBridge.afterAttach = () => {
      view.dispatch({ effects: settingsEffects(getState().settings, activeTab()?.large) })
      setState({ docLines: view.state.doc.lines })
      const sel = view.state.selection.main
      const line = view.state.doc.lineAt(sel.head)
      setState({ cursor: { line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from) } })
    }
    return () => {
      editorBridge.detach()
      editorBridge.view = null
      view.destroy()
    }
  }, [])

  useEffect(() => {
    const tab = activeTab()
    // A large file still streaming in has no document yet.
    if (isEditable(tab) && tab!.loading === undefined) editorBridge.attach(tab!)
    else editorBridge.detach()
  }, [tabId, tabKind, tabLoading])

  // Re-pick the syntax after "Save As" renames the file, a kind change or a manual choice.
  const languageKey = useRef('')
  useEffect(() => {
    const tab = activeTab()
    if (!tab || !isEditable(tab) || editorBridge.currentTabId !== tab.id) return
    const key = `${tab.kind}|${tab.name}|${tab.language ?? ''}`
    const previous = languageKey.current
    languageKey.current = `${tab.id}|${key}`
    if (!previous.startsWith(`${tab.id}|`) || previous === languageKey.current) return
    // Only the first line matters for detection (shebang); don't serialise a large document.
    const content = editorBridge.getDoc(tab.id)?.line(1).text ?? tab.content
    editorBridge.setLanguage(tab.id, tabLanguageExtension(tab, content, (ext) => editorBridge.setLanguage(tab.id, ext)))
  }, [tabId, tabKind, tabName, tabLanguage])

  useEffect(() => {
    editorBridge.view?.dispatch({ effects: settingsEffects(settings, activeTab()?.large) })
  }, [settings.lineNumbers, settings.lineWrapping, settings.editorFontSize, settings.editorFontFamily])

  useEffect(() => {
    if (visible) editorBridge.view?.requestMeasure()
  }, [visible])

  useEffect(() => {
    if (!reveal || !visible || reveal.seq === handledReveal.current || reveal.tabId !== tabId) return
    if (reveal.line === undefined) return
    handledReveal.current = reveal.seq
    const s = getState()
    const focus = s.viewMode === 'edit' || activeTab(s)?.kind === 'text'
    requestAnimationFrame(() =>
      editorBridge.revealLine(reveal.line!, { focus, column: reveal.column, length: reveal.length })
    )
  }, [reveal, visible, tabId])

  return (
    <div
      className="editor-host"
      ref={hostRef}
      onPointerEnter={() => setDriver('editor')}
      onWheel={() => setDriver('editor')}
      onKeyDown={() => setDriver('editor')}
    />
  )
}
