/**
 * The editor's find / replace panel: a floating card in the app's own style (CodeMirror's default
 * panel ignores the theme), with a match count and jump-as-you-type, plus a strong highlight and
 * a zoom effect on the current match so it is obvious where a search landed.
 */
import { Annotation, EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery
} from '@codemirror/search'
import { displayKey, keyOf } from '@shared/keybindings'
import type { MenuCommand } from '@shared/types'
import { showMatchPulse } from '@/lib/findPulse'
import { t } from '@/lib/i18n'

/** Stop counting here; the label then reads "100000+". */
const MATCH_LIMIT = 100_000
/** Larger documents only search on Enter: a miss would scan everything on each keystroke. */
const TYPE_TO_JUMP_LIMIT = 4_000_000
/** Counting runs in windows of this many characters so the UI never blocks for long. */
const COUNT_WINDOW = 2_000_000

/** Selection moves made while typing: the zoom effect waits until typing pauses. */
const typing = Annotation.define<boolean>()

const ICONS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  case: '<path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"/><path d="M22 9v7"/><path d="M3.304 13h6.392"/><circle cx="18.5" cy="12.5" r="3.5"/>',
  word: '<circle cx="7" cy="12" r="3"/><path d="M10 9v6"/><circle cx="17" cy="12" r="3"/><path d="M14 7v8"/><path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"/>',
  regex: '<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/>',
  all: '<path d="M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"/><path d="M9 6v12"/>',
  replace: '<path d="M14 4a1 1 0 0 1 1-1"/><path d="M15 10a1 1 0 0 1-1-1"/><path d="M21 4a1 1 0 0 0-1-1"/><path d="M21 9a1 1 0 0 1-1 1"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a2 2 0 0 1 2-2h2"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  replaceAll: '<path d="M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"/><path d="M14 4a1 1 0 0 1 1-1"/><path d="M15 10a1 1 0 0 1-1-1"/><path d="M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"/><path d="M21 4a1 1 0 0 0-1-1"/><path d="M21 9a1 1 0 0 1-1 1"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a2 2 0 0 1 2-2h2"/><rect x="3" y="14" width="7" height="7" rx="1"/>'
} as const

function icon(name: keyof typeof ICONS): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

/** "Find Next (⌘G)". */
function tip(label: string, command?: MenuCommand): string {
  const key = command ? displayKey(keyOf(command, window.mf.platform), window.mf.platform) : ''
  return key ? `${label} (${key})` : label
}

function iconButton(className: string, name: string, svg: keyof typeof ICONS, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.name = name
  b.title = title
  b.setAttribute('aria-label', title)
  b.innerHTML = icon(svg)
  // Keep the caret in the find field.
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', onClick)
  return b
}

function div(className: string, ...children: HTMLElement[]): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  d.append(...children)
  return d
}

/** Zoom the match at from…to once the editor has scrolled it into view. */
export function pulseEditorMatch(view: EditorView, from: number, to: number, tries = 6): void {
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return
    const a = view.coordsAtPos(from, 1)
    const b = view.coordsAtPos(to, -1)
    const box = view.scrollDOM.getBoundingClientRect()
    if (!a || !b || a.bottom < box.top || a.top > box.bottom) {
      if (tries > 0) pulseEditorMatch(view, from, to, tries - 1)
      return
    }
    if (Math.abs(a.top - b.top) < (a.bottom - a.top) / 2) {
      const node = view.domAtPos(from).node
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement
      showMatchPulse(
        { left: a.left, top: a.top, width: Math.max(2, b.right - a.left), height: a.bottom - a.top },
        view.state.sliceDoc(from, to),
        el ? getComputedStyle(el) : null
      )
    } else {
      // Spans several lines: outline the whole block instead of redrawing the text.
      const left = view.contentDOM.getBoundingClientRect().left
      showMatchPulse({ left, top: a.top, width: box.right - left - 12, height: b.bottom - a.top })
    }
  })
}

class FindPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private query: SearchQuery
  private readonly field: HTMLInputElement
  private readonly replaceField: HTMLInputElement
  private readonly wrap: HTMLElement
  private readonly countEl: HTMLElement
  private readonly caseBtn: HTMLButtonElement
  private readonly wordBtn: HTMLButtonElement
  private readonly regexBtn: HTMLButtonElement
  private readonly expandBtn: HTMLButtonElement
  /** Where as-you-type searching starts, and the selection to return to on no match. */
  private anchor
  private moved = false
  /** Start of every match, ascending. */
  private positions: number[] = []
  private complete = false
  private capped = false
  private countToken = 0
  private countTimer = 0
  private pulseTimer = 0

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state)
    this.anchor = view.state.selection.main

    this.field = document.createElement('input')
    this.field.className = 'find-input'
    this.field.name = 'search'
    this.field.placeholder = t('find.placeholder')
    this.field.setAttribute('aria-label', t('find.placeholder'))
    this.field.setAttribute('main-field', 'true')
    this.field.spellcheck = false
    this.field.addEventListener('input', (e) => {
      // Wait for the IME: pinyin letters mid-composition are not what is being searched for.
      if (!(e as InputEvent).isComposing) this.onSearchInput()
    })
    this.field.addEventListener('compositionend', () => this.onSearchInput())

    this.replaceField = document.createElement('input')
    this.replaceField.className = 'find-input'
    this.replaceField.name = 'replace'
    this.replaceField.placeholder = t('find.replaceWith')
    this.replaceField.setAttribute('aria-label', t('find.replaceWith'))
    this.replaceField.spellcheck = false
    this.replaceField.addEventListener('input', () => this.commit())

    this.countEl = document.createElement('span')
    this.countEl.className = 'find-count'
    this.countEl.setAttribute('aria-live', 'polite')

    this.caseBtn = iconButton('find-opt', 'case', 'case', tip(t('search.caseSensitive'), 'find-toggle-case'), () => this.toggle('caseSensitive'))
    this.wordBtn = iconButton('find-opt', 'word', 'word', tip(t('search.wholeWord'), 'find-toggle-word'), () => this.toggle('wholeWord'))
    this.regexBtn = iconButton('find-opt', 're', 'regex', tip(t('search.regex'), 'find-toggle-regex'), () => this.toggle('regexp'))
    this.expandBtn = iconButton('find-expand', 'toggleReplace', 'chevron', t('find.toggleReplace'), () => this.setReplaceOpen(!this.dom.classList.contains('show-replace')))

    this.wrap = div('find-input-wrap', this.field, this.countEl, this.caseBtn, this.wordBtn, this.regexBtn)
    const searchRow = div(
      'find-row',
      this.wrap,
      iconButton('find-btn', 'prev', 'up', tip(t('cmd.findPrev'), 'find-prev'), () => findPrevious(view)),
      iconButton('find-btn', 'next', 'down', tip(t('cmd.findNext'), 'find-next'), () => findNext(view)),
      iconButton('find-btn', 'select', 'all', tip(t('find.selectAll'), 'select-all-occurrences'), () => selectMatches(view)),
      iconButton('find-btn', 'closePanel', 'close', t('find.close'), () => closeSearchPanel(view))
    )
    const replaceRow = div(
      'find-row find-replace-row',
      div('find-input-wrap', this.replaceField),
      iconButton('find-btn', 'replace', 'replace', t('find.replace'), () => replaceNext(view)),
      iconButton('find-btn', 'replaceAll', 'replaceAll', t('find.replaceAll'), () => replaceAll(view))
    )
    this.dom = div('cm-find-panel find-widget', this.expandBtn, div('find-rows', searchRow, replaceRow))
    this.dom.addEventListener('keydown', (e) => this.keydown(e))
    // Sent by "Replace…" (⌥⌘F / Ctrl+H).
    this.dom.addEventListener('mf-show-replace', () => {
      this.setReplaceOpen(true)
      this.replaceField.focus()
      this.replaceField.select()
    })
    this.showQuery()
    this.setReplaceOpen(!!this.query.replace)
    this.scheduleCount(0)
  }

  mount(): void {
    this.field.focus()
    this.field.select()
  }

  destroy(): void {
    this.countToken++
    clearTimeout(this.countTimer)
    clearTimeout(this.pulseTimer)
  }

  update(update: ViewUpdate): void {
    let queryChanged = false
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value
          queryChanged = true
        }
      }
    }
    if (queryChanged) this.showQuery()
    if (update.docChanged) this.anchor = this.anchor.map(update.changes)
    if (queryChanged || update.docChanged) this.scheduleCount(queryChanged ? 0 : 150)
    if (update.selectionSet) {
      // Any move that isn't our own (find next, a click…) is the new place to search from.
      if (!update.transactions.some((tr) => tr.annotation(typing))) {
        this.anchor = update.state.selection.main
        this.moved = false
      }
      this.renderCount()
    }
  }

  private setReplaceOpen(open: boolean): void {
    this.dom.classList.toggle('show-replace', open)
    this.expandBtn.setAttribute('aria-expanded', String(open))
  }

  private showQuery(): void {
    const q = this.query
    if (this.field.value !== q.search) this.field.value = q.search
    if (this.replaceField.value !== q.replace) this.replaceField.value = q.replace
    this.caseBtn.classList.toggle('on', q.caseSensitive)
    this.wordBtn.classList.toggle('on', q.wholeWord)
    this.regexBtn.classList.toggle('on', q.regexp)
  }

  private commit(next: Partial<Pick<SearchQuery, 'caseSensitive' | 'regexp' | 'wholeWord'>> = {}): boolean {
    const query = new SearchQuery({
      search: this.field.value,
      replace: this.replaceField.value,
      caseSensitive: next.caseSensitive ?? this.query.caseSensitive,
      regexp: next.regexp ?? this.query.regexp,
      wholeWord: next.wholeWord ?? this.query.wholeWord
    })
    if (query.eq(this.query)) return false
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
    this.showQuery()
    this.scheduleCount(0)
    return true
  }

  private toggle(option: 'caseSensitive' | 'regexp' | 'wholeWord'): void {
    if (this.commit({ [option]: !this.query[option] })) this.jumpAsYouType()
  }

  private onSearchInput(): void {
    if (this.commit()) this.jumpAsYouType()
  }

  /** Select the first match from where the search began, keeping the caret in the find field. */
  private jumpAsYouType(): void {
    const { view, query } = this
    if (view.state.doc.length > TYPE_TO_JUMP_LIMIT) return
    clearTimeout(this.pulseTimer)
    const match = query.search && query.valid ? this.firstMatch() : null
    if (!match) {
      if (this.moved) {
        this.moved = false
        view.dispatch({
          selection: EditorSelection.single(this.anchor.anchor, this.anchor.head),
          effects: EditorView.scrollIntoView(this.anchor.head, { y: 'center' }),
          annotations: typing.of(true)
        })
      }
      return
    }
    this.moved = true
    view.dispatch({
      selection: EditorSelection.single(match.from, match.to),
      effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'center', xMargin: 80 }),
      userEvent: 'select.search',
      annotations: typing.of(true)
    })
    this.pulseTimer = window.setTimeout(() => pulseEditorMatch(view, match.from, match.to), 260)
  }

  private firstMatch(): { from: number; to: number } | null {
    const { state } = this.view
    const search = (from: number, to?: number) => {
      const cursor = this.query.getCursor(state, from, to)
      for (let m = cursor.next(); !m.done; m = cursor.next()) if (m.value.from < m.value.to) return m.value
      return null
    }
    return search(this.anchor.from) ?? search(0, this.anchor.from)
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault()
    } else if (e.key === 'Enter' && !e.isComposing) {
      if (e.target === this.field) {
        e.preventDefault()
        ;(e.shiftKey ? findPrevious : findNext)(this.view)
      } else if (e.target === this.replaceField) {
        e.preventDefault()
        replaceNext(this.view)
      }
    }
  }

  /* ---------------- match count ---------------- */

  private scheduleCount(delay: number): void {
    clearTimeout(this.countTimer)
    if (delay) this.countTimer = window.setTimeout(() => this.startCount(), delay)
    else this.startCount()
  }

  /** Count in short slices over an immutable snapshot, so typing never waits for a big document. */
  private startCount(): void {
    const token = ++this.countToken
    const { query } = this
    const { state } = this.view
    const positions: number[] = []
    this.positions = positions
    this.capped = false
    this.complete = !query.search || !query.valid
    this.renderCount()
    if (this.complete) return
    const length = state.doc.length
    // A match can straddle two windows; the overlap finds it and the check below drops repeats.
    const overlap = query.regexp ? 2000 : query.search.length
    let pos = 0
    const slice = () => {
      if (token !== this.countToken) return
      const start = performance.now()
      while (pos < length && !this.capped && performance.now() - start < 12) {
        const to = Math.min(length, pos + COUNT_WINDOW)
        const cursor = query.getCursor(state, pos, to)
        for (let m = cursor.next(); !m.done; m = cursor.next()) {
          const { from, to: end } = m.value
          if (from === end || (positions.length && from <= positions[positions.length - 1])) continue
          positions.push(from)
          if (positions.length >= MATCH_LIMIT) {
            this.capped = true
            break
          }
        }
        pos = to >= length ? length : to - overlap
      }
      this.complete = pos >= length || this.capped
      this.renderCount()
      if (!this.complete) window.setTimeout(slice, 0)
    }
    slice()
  }

  private currentIndex(): number {
    const { main } = this.view.state.selection
    if (main.empty) return -1
    const { positions } = this
    let lo = 0
    let hi = positions.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (positions[mid] === main.from) return mid
      if (positions[mid] < main.from) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }

  private renderCount(): void {
    const { query, positions, complete, capped } = this
    const hasQuery = !!query.search
    const invalid = hasQuery && !query.valid
    const none = hasQuery && !invalid && complete && positions.length === 0
    this.wrap.classList.toggle('invalid', invalid)
    this.wrap.classList.toggle('no-results', none)
    let label = ''
    if (invalid) label = t('find.invalid')
    else if (none) label = t('find.noResults')
    else if (hasQuery) {
      const total = `${positions.length}${capped || !complete ? '+' : ''}`
      const index = this.currentIndex()
      if (!positions.length) label = '…'
      else label = index >= 0 ? t('find.count', { i: index + 1, n: total }) : t('find.total', { n: total })
    }
    if (this.countEl.textContent !== label) this.countEl.textContent = label
  }
}

/** Zoom on every jump to a match: find next / previous, replace-and-find, quick find. */
const pulseOnFind = EditorView.updateListener.of((update) => {
  for (const tr of update.transactions) {
    if (tr.annotation(typing)) continue
    if ((tr.isUserEvent('select.search') || tr.isUserEvent('input.replace')) && update.state.selection.ranges.length === 1) {
      const { from, to } = update.state.selection.main
      if (from !== to) pulseEditorMatch(update.view, from, to)
      return
    }
  }
})

const findTheme = EditorView.theme({
  // The panel floats over the top-right corner of the text instead of pushing it down.
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    top: '8px !important',
    left: 'auto',
    right: '16px',
    maxWidth: 'calc(100% - 24px)',
    backgroundColor: 'transparent',
    color: 'inherit',
    border: 'none'
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--find-match)',
    outline: '1px solid var(--find-match-border)',
    borderRadius: '2px'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--find-current)',
    outline: '2px solid var(--find-current)',
    boxShadow: '0 0 0 4px var(--find-current-ring)',
    color: 'var(--find-current-text) !important'
  },
  '.cm-searchMatch-selected *': { color: 'var(--find-current-text) !important' }
})

/** Search for an editor: the panel above, results centred in the view. */
export const findExtensions: Extension = [
  search({
    top: true,
    createPanel: (view) => new FindPanel(view),
    scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'center', xMargin: 80 })
  }),
  findTheme,
  pulseOnFind
]
