import { EditorSelection, type EditorState, type Extension, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import { redo, selectAll, undo } from '@codemirror/commands'
import type { Tab } from '@/store'
import { runFormat, type FormatCommand } from './commands'
import { compartments } from './setup'

/**
 * Owns the single CodeMirror view and the per-tab editor states (so each tab keeps
 * its own undo history, selection and scroll position).
 */
class EditorBridge {
  view: EditorView | null = null
  currentTabId: string | null = null
  private states = new Map<string, EditorState>()
  private scrollTops = new Map<string, number>()
  makeState: ((tab: Tab) => EditorState) | null = null
  afterAttach: (() => void) | null = null

  attach(tab: Tab): void {
    const view = this.view
    if (!view || !this.makeState) return
    if (this.currentTabId === tab.id) return
    this.detach()
    const state = this.states.get(tab.id) ?? this.makeState(tab)
    view.setState(state)
    this.currentTabId = tab.id
    this.afterAttach?.()
    const top = this.scrollTops.get(tab.id)
    if (top !== undefined) {
      requestAnimationFrame(() => {
        if (this.currentTabId === tab.id) view.scrollDOM.scrollTop = top
      })
    }
  }

  /** Save the current tab's state and blank the editor. */
  detach(): void {
    const view = this.view
    if (!view || !this.currentTabId) return
    this.states.set(this.currentTabId, view.state)
    this.scrollTops.set(this.currentTabId, view.scrollDOM.scrollTop)
    this.currentTabId = null
  }

  drop(tabId: string): void {
    this.states.delete(tabId)
    this.scrollTops.delete(tabId)
    if (this.currentTabId === tabId) this.currentTabId = null
  }

  /** Replace a tab's document (e.g. after an external change or a preview checkbox toggle). */
  setContent(tabId: string, content: string, userEvent = 'external'): void {
    const view = this.view
    if (view && this.currentTabId === tabId) {
      const current = view.state.doc.toString()
      if (current === content) return
      // Minimal diff keeps cursor and scroll position stable.
      let start = 0
      while (start < current.length && start < content.length && current[start] === content[start]) start++
      let endA = current.length
      let endB = content.length
      while (endA > start && endB > start && current[endA - 1] === content[endB - 1]) {
        endA--
        endB--
      }
      view.dispatch({ changes: { from: start, to: endA, insert: content.slice(start, endB) }, userEvent })
    } else {
      this.states.delete(tabId)
    }
  }

  /** Swap a tab's language (e.g. once a lazily loaded syntax arrives, or the user picks one). */
  setLanguage(tabId: string, language: Extension): void {
    const effects = compartments.language.reconfigure(language)
    if (this.view && this.currentTabId === tabId) this.view.dispatch({ effects })
    else {
      const state = this.states.get(tabId)
      if (state) this.states.set(tabId, state.update({ effects }).state)
    }
  }

  /** The document of a tab without turning it into a string (large files). */
  getDoc(tabId: string): Text | null {
    if (this.view && this.currentTabId === tabId) return this.view.state.doc
    return this.states.get(tabId)?.doc ?? null
  }

  /** Forget a tab's editor state and rebuild it (a large file was reloaded from disk). */
  resetTab(tab: Tab): void {
    this.states.delete(tab.id)
    this.scrollTops.delete(tab.id)
    if (this.currentTabId === tab.id) {
      this.currentTabId = null
      this.attach(tab)
    }
  }

  getContent(tabId: string): string | null {
    if (this.view && this.currentTabId === tabId) return this.view.state.doc.toString()
    return this.states.get(tabId)?.doc.toString() ?? null
  }

  hasFocus(): boolean {
    return !!this.view?.hasFocus
  }

  focus(): void {
    this.view?.focus()
  }

  format(cmd: FormatCommand): void {
    if (this.view && this.currentTabId) runFormat(this.view, cmd)
  }

  openSearch(): void {
    if (this.view) openSearchPanel(this.view)
  }

  selectAll(): void {
    if (this.view) selectAll(this.view)
  }

  /** Undo / redo on the active document even while the editor is hidden (reading mode). */
  undo(): boolean {
    return !!this.view && !!this.currentTabId && undo(this.view)
  }

  redo(): boolean {
    return !!this.view && !!this.currentTabId && redo(this.view)
  }

  /** Move the cursor to a 0-based line and scroll it to the top area. */
  revealLine(line: number, opts: { focus?: boolean; column?: number; length?: number } = {}): void {
    const view = this.view
    if (!view) return
    const doc = view.state.doc
    const n = Math.max(1, Math.min(doc.lines, line + 1))
    const l = doc.line(n)
    const from = Math.min(l.to, l.from + (opts.column ?? 0))
    const to = Math.min(l.to, from + (opts.length ?? 0))
    view.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 60 })
    })
    if (opts.focus) view.focus()
  }

  /** 0-based fractional line at the top of the viewport. */
  topLine(): number {
    const view = this.view
    if (!view) return 0
    const rect = view.scrollDOM.getBoundingClientRect()
    const y = rect.top - view.documentTop
    const block = view.lineBlockAtHeight(Math.max(0, y))
    const line = view.state.doc.lineAt(block.from).number - 1
    const frac = block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0
    return line + frac
  }

  /** Scroll so that 0-based fractional `line` is at the top of the viewport. */
  scrollToLine(line: number): void {
    const view = this.view
    if (!view) return
    const doc = view.state.doc
    const n = Math.max(0, Math.min(doc.lines - 1, Math.floor(line)))
    const frac = line - n
    const block = view.lineBlockAt(doc.line(n + 1).from)
    const scroller = view.scrollDOM
    const docOffset = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop = docOffset + block.top + frac * block.height
  }

  atBottom(): boolean {
    const s = this.view?.scrollDOM
    return !!s && s.scrollTop + s.clientHeight >= s.scrollHeight - 2
  }

  scrollToBottom(): void {
    const s = this.view?.scrollDOM
    if (s) s.scrollTop = s.scrollHeight
  }
}

export const editorBridge = new EditorBridge()
