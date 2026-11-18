/**
 * Sublime Text style editing commands for CodeMirror.
 * Most are StateCommands ({ state, dispatch }) so they can be unit tested without a DOM.
 */
import {
  EditorSelection,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type SelectionRange,
  type StateCommand,
  type Transaction
} from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  cursorMatchingBracket,
  deleteLine,
  deleteLineBoundaryBackward,
  deleteToLineEnd,
  indentLess,
  indentMore,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectLine,
  selectParentSyntax,
  toggleBlockComment,
  toggleComment,
  undoSelection
} from '@codemirror/commands'
import { ensureSyntaxTree, foldAll, foldCode, foldEffect, foldable, matchBrackets, unfoldAll, unfoldCode } from '@codemirror/language'
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery
} from '@codemirror/search'

type Target = { state: EditorState; dispatch: (tr: Transaction) => void }

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

/** ⇧⌘D: duplicate the line (empty selection) or the selected text. */
export const duplicateSelection: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.every((r) => r.empty)) return copyLineDown({ state, dispatch })
  const tr = state.changeByRange((r) =>
    r.empty
      ? { range: r }
      : {
          changes: { from: r.to, insert: state.sliceDoc(r.from, r.to) },
          range: EditorSelection.range(r.to, r.to + (r.to - r.from))
        }
  )
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.copyline' }))
  return true
}

/** ⌘J: join the selected lines (or the current and next line) with single spaces. */
export const joinLines: StateCommand = ({ state, dispatch }) => {
  const doc = state.doc
  const lineNos = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number
    let b = doc.lineAt(r.to).number
    if (b === a) b = Math.min(a + 1, doc.lines)
    for (let n = a; n < b; n++) lineNos.add(n)
  }
  if (!lineNos.size) return false
  const changes = [...lineNos].sort((x, y) => x - y).map((n) => {
    const line = doc.line(n)
    const next = doc.line(n + 1)
    const trail = line.text.length - line.text.trimEnd().length
    const lead = /^\s*/.exec(next.text)![0].length
    const glue = line.text.trim() && next.text.trim() ? ' ' : ''
    return { from: line.to - trail, to: next.from + lead, insert: glue }
  })
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.join' }))
  return true
}

/** ⇧⌘↩: open a new line above, keeping the indentation. */
export const insertLineBefore: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((r) => {
    const line = state.doc.lineAt(r.from)
    const indent = /^\s*/.exec(line.text)![0]
    return {
      changes: { from: line.from, insert: indent + state.lineBreak },
      range: EditorSelection.cursor(line.from + indent.length)
    }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** F5 / F9: sort the selected lines (whole document when nothing is selected). */
export function sortLines(caseSensitive: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const doc = state.doc
    let first = doc.line(1)
    let last = doc.line(doc.lines)
    const main = state.selection.main
    if (!state.selection.ranges.every((r) => r.empty)) {
      first = doc.lineAt(main.from)
      last = doc.lineAt(main.to)
      if (last.number > first.number && main.to === last.from) last = doc.line(last.number - 1)
    }
    const lines = doc.sliceString(first.from, last.to).split('\n')
    const sorted = [...lines].sort((a, b) => {
      if (!caseSensitive) {
        const c = a.localeCompare(b, undefined, { sensitivity: 'base' })
        if (c) return c
      }
      return a < b ? -1 : a > b ? 1 : 0
    })
    const text = sorted.join('\n')
    if (text === lines.join('\n')) return true
    dispatch(
      state.update({
        changes: { from: first.from, to: last.to, insert: text },
        selection: EditorSelection.range(first.from, first.from + text.length),
        userEvent: 'input.sort'
      })
    )
    return true
  }
}

function convertCase(fn: (s: string) => string): StateCommand {
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((r) => {
      const range = r.empty ? state.wordAt(r.head) : r
      if (!range) return { range: r }
      const text = fn(state.sliceDoc(range.from, range.to))
      return {
        changes: { from: range.from, to: range.to, insert: text },
        range: EditorSelection.range(range.from, range.from + text.length)
      }
    })
    dispatch(state.update(tr, { userEvent: 'input.case' }))
    return true
  }
}

export const upperCase = convertCase((s) => s.toUpperCase())
export const lowerCase = convertCase((s) => s.toLowerCase())

/** ⇧⌘V: paste, re-indenting the clipboard text to the current line's indentation. */
export function pasteAndIndent(target: Target, text: string): boolean {
  const { state, dispatch } = target
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length)
  const common = indents.length ? Math.min(...indents) : 0
  const tr = state.changeByRange((r) => {
    const indent = /^\s*/.exec(state.doc.lineAt(r.from).text)![0]
    const insert = lines
      .map((l, i) => {
        const stripped = l.slice(Math.min(common, /^\s*/.exec(l)![0].length))
        if (i === 0) return stripped
        return stripped ? indent + stripped : ''
      })
      .join(state.lineBreak)
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.paste' }))
  return true
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/** ⇧⌘L: one selection per line of each multi-line selection. */
export const splitIntoLines: StateCommand = ({ state, dispatch }) => {
  const doc = state.doc
  const ranges: SelectionRange[] = []
  for (const r of state.selection.ranges) {
    if (r.empty) {
      ranges.push(r)
      continue
    }
    const a = doc.lineAt(r.from).number
    const b = doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) {
      const line = doc.line(n)
      if (n === b && n > a && r.to === line.from) continue
      ranges.push(EditorSelection.range(Math.max(line.from, r.from), Math.min(line.to, r.to)))
    }
  }
  if (ranges.length <= 1 && state.selection.ranges.length <= 1) return false
  dispatch(state.update({ selection: EditorSelection.create(ranges, ranges.length - 1), userEvent: 'select' }))
  return true
}

/** ⌘K ⌘D: drop the current occurrence and select the next one instead. */
export const skipOccurrence: StateCommand = ({ state, dispatch }) => {
  const main = state.selection.main
  if (main.empty) return selectNextOccurrence({ state, dispatch })
  let next: Transaction | null = null
  selectNextOccurrence({ state, dispatch: (tr) => (next = tr) })
  if (!next) return false
  const sel = (next as Transaction).newSelection
  const kept = sel.ranges.filter((r) => !(r.from === main.from && r.to === main.to))
  if (!kept.length) return false
  const mainIndex = Math.max(0, kept.findIndex((r) => r.from === sel.main.from && r.to === sel.main.to))
  dispatch(
    state.update({
      selection: EditorSelection.create(kept, mainIndex),
      effects: EditorView.scrollIntoView(sel.main.head),
      userEvent: 'select.search'
    })
  )
  return true
}

/** ⌃⌘G / Alt+F3: select every occurrence of the selection (or the word at the cursor). */
export const selectAllOccurrences: StateCommand = (target) => {
  let state = target.state
  if (state.selection.main.empty) {
    let tr: Transaction | null = null
    selectNextOccurrence({ state, dispatch: (t) => (tr = t) })
    if (!tr) return false
    state = (tr as Transaction).state
    target.dispatch(tr)
  }
  return selectSelectionMatches({ state, dispatch: target.dispatch })
}

const OPEN_BRACKETS = '([{'

/** ⌃⇧M: select inside the enclosing brackets; again to include the brackets. */
export const expandToBrackets: StateCommand = ({ state, dispatch }) => {
  const r = state.selection.main
  const limit = Math.max(0, r.from - 20000)
  for (let pos = r.from - 1; pos >= limit; pos--) {
    if (!OPEN_BRACKETS.includes(state.doc.sliceString(pos, pos + 1))) continue
    const m = matchBrackets(state, pos, 1)
    if (!m || !m.matched || !m.end || m.end.from < r.to) continue
    const inner = EditorSelection.range(pos + 1, m.end.from)
    const sel = r.from === inner.from && r.to === inner.to ? EditorSelection.range(pos, m.end.to) : inner
    dispatch(state.update({ selection: sel, scrollIntoView: true, userEvent: 'select' }))
    return true
  }
  return false
}

function indentWidth(text: string, tabSize: number): number {
  let w = 0
  for (const ch of text) {
    if (ch === ' ') w++
    else if (ch === '\t') w += tabSize - (w % tabSize)
    else break
  }
  return w
}

/** ⇧⌘J: select the surrounding lines with the same or deeper indentation. */
export const expandToIndentation: StateCommand = ({ state, dispatch }) => {
  const doc = state.doc
  let ref = doc.lineAt(state.selection.main.head)
  for (let n = ref.number; n <= doc.lines && !ref.text.trim(); n++) ref = doc.line(n)
  if (!ref.text.trim()) return false
  const tab = state.tabSize
  const level = indentWidth(ref.text, tab)
  // At the top level, blank lines end the block (a paragraph); deeper, they are part of it.
  const belongs = (text: string) => (text.trim() ? indentWidth(text, tab) >= level : level > 0)
  let start = ref.number
  let end = ref.number
  while (start > 1 && belongs(doc.line(start - 1).text)) start--
  while (end < doc.lines && belongs(doc.line(end + 1).text)) end++
  while (start < end && !doc.line(start).text.trim()) start++
  while (end > start && !doc.line(end).text.trim()) end--
  dispatch(state.update({ selection: EditorSelection.range(doc.line(start).from, doc.line(end).to), userEvent: 'select' }))
  return true
}

/* ------------------------------------------------------------------ */
/* Find                                                                */
/* ------------------------------------------------------------------ */

function selectionOrWord(state: EditorState): { from: number; to: number; text: string } | null {
  const r = state.selection.main
  const range = r.empty ? state.wordAt(r.head) : r
  if (!range) return null
  return { from: range.from, to: range.to, text: state.sliceDoc(range.from, range.to) }
}

function querySpec(state: EditorState, search: string): SearchQuery {
  const q = getSearchQuery(state)
  return new SearchQuery({ search, caseSensitive: q.caseSensitive, regexp: false, wholeWord: q.wholeWord, replace: q.replace })
}

/** ⌘E: make the selection (or word) the search text without moving. */
export const seedFindFromSelection: StateCommand = ({ state, dispatch }) => {
  const sel = selectionOrWord(state)
  if (!sel || sel.text.includes('\n')) return false
  dispatch(state.update({ effects: setSearchQuery.of(querySpec(state, sel.text)) }))
  return true
}

/** ⌥⌘G: search for the selection (or word) and jump to its next occurrence. */
export function quickFindNext(view: EditorView): boolean {
  const sel = selectionOrWord(view.state)
  if (!sel || sel.text.includes('\n')) return false
  const wasEmpty = view.state.selection.main.empty
  view.dispatch({ effects: setSearchQuery.of(querySpec(view.state, sel.text)) })
  if (wasEmpty) {
    view.dispatch({ selection: EditorSelection.range(sel.from, sel.to), scrollIntoView: true })
    return true
  }
  return findNext(view)
}

/** ⌘G / ⇧⌘G: like Sublime, seed the search from the selection if there is no query yet. */
export function findNextOrPrev(view: EditorView, forward: boolean): boolean {
  if (!getSearchQuery(view.state).valid) {
    const sel = selectionOrWord(view.state)
    if (sel && !sel.text.includes('\n')) view.dispatch({ effects: setSearchQuery.of(querySpec(view.state, sel.text)) })
  }
  return forward ? findNext(view) : findPrevious(view)
}

/** ⌥⌘F / Ctrl+H: open the search panel with the replace field focused. */
export function openReplace(view: EditorView): boolean {
  openSearchPanel(view)
  view.dom.querySelector('.cm-find-panel')?.dispatchEvent(new Event('mf-show-replace'))
  return true
}

/** ⌥⌘R / ⌥⌘C / ⌥⌘W inside the search panel. */
export function toggleSearchOption(view: EditorView, option: 'regexp' | 'caseSensitive' | 'wholeWord'): boolean {
  const q = getSearchQuery(view.state)
  const next = new SearchQuery({
    search: q.search,
    replace: q.replace,
    caseSensitive: option === 'caseSensitive' ? !q.caseSensitive : q.caseSensitive,
    regexp: option === 'regexp' ? !q.regexp : q.regexp,
    wholeWord: option === 'wholeWord' ? !q.wholeWord : q.wholeWord
  })
  view.dispatch({ effects: setSearchQuery.of(next) })
  return true
}

/* ------------------------------------------------------------------ */
/* Bookmarks                                                           */
/* ------------------------------------------------------------------ */

class BookmarkMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-bookmark-marker'
    return el
  }
}
const bookmarkMarker = new BookmarkMarker()

const toggleBookmarkEffect = StateEffect.define<number>({ map: (pos, mapping) => mapping.mapPos(pos) })
const clearBookmarksEffect = StateEffect.define<null>()

export const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(clearBookmarksEffect)) {
        set = RangeSet.empty
      } else if (e.is(toggleBookmarkEffect)) {
        const line = tr.state.doc.lineAt(e.value)
        let has = false
        set.between(line.from, line.to, () => {
          has = true
        })
        set = has
          ? set.update({ filter: (from) => from < line.from || from > line.to })
          : set.update({ add: [bookmarkMarker.range(line.from)], sort: true })
      }
    }
    return set
  }
})

/** Gutter + state for bookmarks; include in every main editor state. */
export const bookmarks = [
  bookmarkField,
  gutter({
    class: 'cm-bookmark-gutter',
    markers: (v) => v.state.field(bookmarkField),
    initialSpacer: () => bookmarkMarker
  })
]

/** Line numbers (0-based) of all bookmarks, in order. */
export function bookmarkLines(state: EditorState): number[] {
  const out: number[] = []
  const field = state.field(bookmarkField, false)
  if (!field) return out
  const cursor = field.iter()
  for (; cursor.value; cursor.next()) out.push(state.doc.lineAt(cursor.from).number - 1)
  return [...new Set(out)]
}

export const toggleBookmark: StateCommand = ({ state, dispatch }) => {
  const lines = new Set(state.selection.ranges.map((r) => state.doc.lineAt(r.head).from))
  dispatch(state.update({ effects: [...lines].map((pos) => toggleBookmarkEffect.of(pos)) }))
  return true
}

export const clearBookmarks: StateCommand = ({ state, dispatch }) => {
  dispatch(state.update({ effects: clearBookmarksEffect.of(null) }))
  return true
}

/** Move the cursor to the next / previous bookmark (wrapping). Returns its 0-based line or -1. */
export function gotoBookmark(target: Target, forward: boolean): number {
  const { state, dispatch } = target
  const lines = bookmarkLines(state)
  if (!lines.length) return -1
  const current = state.doc.lineAt(state.selection.main.head).number - 1
  const line = forward ? (lines.find((l) => l > current) ?? lines[0]) : ([...lines].reverse().find((l) => l < current) ?? lines[lines.length - 1])
  const pos = state.doc.line(line + 1).from
  dispatch(state.update({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) }))
  return line
}

/* ------------------------------------------------------------------ */
/* Folding                                                             */
/* ------------------------------------------------------------------ */

/** ⌘K ⌘N: unfold everything, then fold every level-N heading section (an outline view). */
export function foldLevel(view: EditorView, level: number): boolean {
  unfoldAll(view)
  const state = view.state
  const tree = ensureSyntaxTree(state, state.doc.length, 500)
  if (!tree) return false
  const effects: StateEffect<unknown>[] = []
  tree.iterate({
    enter(node) {
      const m = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)
      if (!m || Number(m[1]) !== level) return
      const line = state.doc.lineAt(node.from)
      const range = foldable(state, line.from, line.to)
      if (range) effects.push(foldEffect.of(range))
    }
  })
  if (effects.length) view.dispatch({ effects })
  return true
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run an editor command on a view. Returns false when the command is not an editor command
 * (or did nothing), so callers can fall back to app-level handling.
 */
export function runEditorCommand(cmd: string, view: EditorView): boolean {
  const fold = /^fold-level-(\d)$/.exec(cmd)
  if (fold) return foldLevel(view, Number(fold[1]))
  switch (cmd) {
    case 'soft-undo':
      return undoSelection(view)
    case 'indent':
      return indentMore(view)
    case 'outdent':
      return indentLess(view)
    case 'swap-line-up':
      return moveLineUp(view)
    case 'swap-line-down':
      return moveLineDown(view)
    case 'duplicate-line':
      return duplicateSelection(view)
    case 'delete-line':
      return deleteLine(view)
    case 'join-lines':
      return joinLines(view)
    case 'insert-line-after':
      return insertBlankLine(view)
    case 'insert-line-before':
      return insertLineBefore(view)
    case 'delete-to-eol':
      return deleteToLineEnd(view)
    case 'delete-to-bol':
      return deleteLineBoundaryBackward(view)
    case 'toggle-comment':
      return toggleComment(view)
    case 'toggle-block-comment':
      return toggleBlockComment(view)
    case 'upper-case':
      return upperCase(view)
    case 'lower-case':
      return lowerCase(view)
    case 'sort-lines':
      return sortLines(false)(view)
    case 'sort-lines-case':
      return sortLines(true)(view)
    case 'fold':
      return foldCode(view)
    case 'unfold':
      return unfoldCode(view)
    case 'fold-all':
      return foldAll(view)
    case 'unfold-all':
      return unfoldAll(view)
    case 'split-into-lines':
      return splitIntoLines(view)
    case 'add-cursor-above':
      return addCursorAbove(view)
    case 'add-cursor-below':
      return addCursorBelow(view)
    case 'select-line':
      return selectLine(view)
    case 'select-next-occurrence':
      return selectNextOccurrence(view)
    case 'skip-occurrence':
      return skipOccurrence(view)
    case 'select-all-occurrences':
      return selectAllOccurrences(view)
    case 'expand-brackets':
      return expandToBrackets(view)
    case 'expand-indentation':
      return expandToIndentation(view)
    case 'expand-scope':
      return selectParentSyntax(view)
    case 'jump-bracket':
      return cursorMatchingBracket(view)
    case 'quick-find-next':
      return quickFindNext(view)
    case 'use-selection-find':
      return seedFindFromSelection(view)
    case 'find-next':
      return findNextOrPrev(view, true)
    case 'find-prev':
      return findNextOrPrev(view, false)
    case 'replace':
      return openReplace(view)
    case 'bookmark-toggle':
      return toggleBookmark(view)
    case 'bookmark-clear':
      return clearBookmarks(view)
    case 'bookmark-next':
      return gotoBookmark(view, true) >= 0
    case 'bookmark-prev':
      return gotoBookmark(view, false) >= 0
    default:
      return false
  }
}
