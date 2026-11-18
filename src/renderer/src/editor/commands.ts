import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Wrap (or unwrap) every selection with `before` / `after`. */
export function toggleWrap(view: EditorView, before: string, after = before, placeholder = ''): boolean {
  const { state } = view
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    const outerFrom = range.from - before.length
    const outerTo = range.to + after.length
    // Selection already surrounded by the markers → remove them.
    if (
      outerFrom >= 0 &&
      outerTo <= state.doc.length &&
      state.sliceDoc(outerFrom, range.from) === before &&
      state.sliceDoc(range.to, outerTo) === after
    ) {
      return {
        changes: [
          { from: outerFrom, to: range.from, insert: '' },
          { from: range.to, to: outerTo, insert: '' }
        ],
        range: EditorSelection.range(outerFrom, range.to - before.length)
      }
    }
    // Selection includes the markers → strip them.
    if (text.length >= before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
      const inner = text.slice(before.length, text.length - after.length)
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length)
      }
    }
    const content = text || placeholder
    return {
      changes: { from: range.from, to: range.to, insert: before + content + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + content.length)
    }
  })
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  view.focus()
  return true
}

function selectedLines(view: EditorView): number[] {
  const { state } = view
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    let b = state.doc.lineAt(r.to).number
    if (b > a && r.to === state.doc.line(b).from) b--
    for (let i = a; i <= b; i++) lines.add(i)
  }
  return [...lines].sort((x, y) => x - y)
}

const LIST_PREFIX = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/

/** Toggle a line prefix (quote, list, task) on the selected lines. */
export function toggleLinePrefix(view: EditorView, kind: 'quote' | 'ul' | 'ol' | 'task'): boolean {
  const { state } = view
  const lines = selectedLines(view)
  const docLines = lines.map((n) => state.doc.line(n))
  const matcher: Record<typeof kind, RegExp> = {
    quote: /^(\s*)>\s?/,
    ul: /^(\s*)[-*+]\s+(?!\[[ xX]\])/,
    ol: /^(\s*)\d+[.)]\s+/,
    task: /^(\s*)[-*+]\s+\[[ xX]\]\s+/
  }
  const all = docLines.every((l) => matcher[kind].test(l.text) || !l.text.trim())
  const changes: ChangeSpec[] = []
  let counter = 1
  for (const line of docLines) {
    if (!line.text.trim() && docLines.length > 1) continue
    if (all) {
      const m = matcher[kind].exec(line.text)
      if (m) changes.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert: '' })
      continue
    }
    const indent = /^\s*/.exec(line.text)![0]
    let prefix = ''
    if (kind === 'quote') prefix = '> '
    else if (kind === 'ul') prefix = '- '
    else if (kind === 'ol') prefix = `${counter++}. `
    else prefix = '- [ ] '
    if (kind === 'quote') {
      changes.push({ from: line.from + indent.length, insert: prefix })
    } else {
      const existing = LIST_PREFIX.exec(line.text)
      changes.push({
        from: line.from + indent.length,
        to: existing ? line.from + existing[0].length : line.from + indent.length,
        insert: prefix
      })
    }
  }
  view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true })
  view.focus()
  return true
}

/** Set heading level (0 removes the heading) on the selected lines; same level toggles off. */
export function setHeading(view: EditorView, level: number): boolean {
  const { state } = view
  const changes: ChangeSpec[] = []
  for (const n of selectedLines(view)) {
    const line = state.doc.line(n)
    const m = /^(\s{0,3})(#{1,6})(\s+|$)/.exec(line.text)
    const current = m ? m[2].length : 0
    const target = current === level ? 0 : level
    const insert = target ? '#'.repeat(target) + ' ' : ''
    if (m) changes.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert })
    else if (target) changes.push({ from: line.from, insert })
  }
  view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true })
  view.focus()
  return true
}

const CURSOR = '${cursor}'

/** Insert a block of text on its own line(s); `${cursor}` in the template marks the caret. */
export function insertBlock(view: EditorView, template: string): boolean {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const selected = state.sliceDoc(range.from, range.to)
  let text = template.replace('{sel}', selected)
  let cursor = text.indexOf(CURSOR)
  if (cursor >= 0) text = text.slice(0, cursor) + text.slice(cursor + CURSOR.length)
  else cursor = text.length
  let from = range.from
  let to = range.to
  let prefix = ''
  if (!selected) {
    if (line.text.trim()) {
      from = to = line.to
      prefix = '\n\n'
    } else {
      from = line.from
      to = line.to
    }
  } else if (range.from !== line.from) {
    prefix = '\n\n'
  }
  const nextLine = to < state.doc.length ? state.doc.lineAt(to + 1) : null
  const suffix = nextLine && nextLine.text.trim() ? '\n\n' : ''
  view.dispatch({
    changes: { from, to, insert: prefix + text + suffix },
    selection: { anchor: from + prefix.length + cursor },
    userEvent: 'input.format',
    scrollIntoView: true
  })
  view.focus()
  return true
}

export function insertLink(view: EditorView, image = false): boolean {
  const { state } = view
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    const isUrl = /^(https?:\/\/|www\.)\S+$/.test(text)
    const bang = image ? '!' : ''
    if (isUrl) {
      const insert = `${bang}[](${text})`
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + bang.length + 1) }
    }
    const label = text || (image ? 'alt' : 'text')
    const insert = `${bang}[${label}](url)`
    const urlStart = range.from + bang.length + label.length + 3
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text ? EditorSelection.range(urlStart, urlStart + 3) : EditorSelection.range(range.from + bang.length + 1, range.from + bang.length + 1 + label.length)
    }
  })
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  view.focus()
  return true
}

export type FormatCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'image'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'task'
  | 'codeblock'
  | 'table'
  | 'hr'
  | 'math'

export function runFormat(view: EditorView, cmd: FormatCommand): boolean {
  switch (cmd) {
    case 'bold':
      return toggleWrap(view, '**', '**', 'bold')
    case 'italic':
      return toggleWrap(view, '*', '*', 'italic')
    case 'strike':
      return toggleWrap(view, '~~', '~~', 'text')
    case 'code':
      return toggleWrap(view, '`', '`', 'code')
    case 'link':
      return insertLink(view)
    case 'image':
      return insertLink(view, true)
    case 'quote':
    case 'ul':
    case 'ol':
    case 'task':
      return toggleLinePrefix(view, cmd)
    case 'codeblock':
      return insertBlock(view, '```${cursor}\n{sel}\n```')
    case 'table':
      return insertBlock(view, '| ${cursor} |  |\n| --- | --- |\n|  |  |')
    case 'hr':
      return insertBlock(view, '---\n${cursor}')
    case 'math':
      return insertBlock(view, '$$\n${cursor}{sel}\n$$')
    default: {
      const level = Number(cmd.slice(1))
      return setHeading(view, level)
    }
  }
}

/** Toggle a GFM task checkbox on a given 0-based source line. Returns the new document or null. */
export function toggleTaskInSource(source: string, line: number): string | null {
  const lines = source.split('\n')
  const text = lines[line]
  if (text === undefined) return null
  const re = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/
  const m = re.exec(text)
  if (!m) return null
  const next = m[2] === ' ' ? 'x' : ' '
  lines[line] = text.replace(re, `$1[${next}]`)
  return lines.join('\n')
}
