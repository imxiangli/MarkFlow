/**
 * Smarter paste for Markdown editors.
 *
 * Spreadsheets (Excel, Numbers, Google Sheets, WPS…) put three things on the clipboard: the
 * cells as tab-separated text, the same cells as an HTML table, and a picture of the range.
 * Pasting should give a Markdown table, not that picture; likewise rich text copied from Word or
 * a web page pastes as its text. Only a clipboard that is really just an image is pasted as one.
 */
import { EditorView } from '@codemirror/view'
import { language } from '@codemirror/language'

export type Grid = string[][]

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Tab-separated cells as spreadsheets copy them: rows end in (CR)LF, and a cell containing a
 * tab, line break or quote is wrapped in double quotes with inner quotes doubled.
 */
export function parseTsv(text: string): Grid {
  const rows: Grid = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const s = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  while (i < s.length) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (ch === '"') {
        quoted = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
    i++
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** Drop empty trailing rows / columns (spreadsheets often copy a ragged right edge). */
export function trimGrid(grid: Grid): Grid {
  const rows = grid.map((r) => [...r])
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop()
  let width = Math.max(0, ...rows.map((r) => r.length))
  while (width > 0 && rows.every((r) => !(r[width - 1] ?? '').trim())) width--
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''))
}

export const cellCount = (grid: Grid): number => grid.reduce((n, r) => n + r.length, 0)

const NUMBER = /^[-+(]?\s*[\u00a5$\u20ac\u00a3]?\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|[kKmMbB])?\)?$/

/** Display width with CJK / full-width characters counted twice, for aligned table source. */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return w
}

const escapeCell = (s: string) => s.trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')

/** A GFM table; the first row is the header and all-numeric columns are right-aligned. */
export function gridToMarkdown(input: Grid): string {
  const grid = trimGrid(input)
  if (!grid.length) return ''
  const rows = grid.map((r) => r.map(escapeCell))
  const width = rows[0].length
  const right = Array.from({ length: width }, (_, c) => {
    const values = rows.slice(1).map((r) => r[c]).filter(Boolean)
    return values.length > 0 && values.every((v) => NUMBER.test(v))
  })
  const widths = Array.from({ length: width }, (_, c) => Math.max(3, ...rows.map((r) => displayWidth(r[c]))))
  const pad = (s: string, c: number) => {
    const space = ' '.repeat(widths[c] - displayWidth(s))
    return right[c] ? space + s : s + space
  }
  const line = (cells: string[]) => `| ${cells.map(pad).join(' | ')} |`
  const rule = `| ${widths.map((w, c) => (right[c] ? '-'.repeat(w - 1) + ':' : '-'.repeat(w))).join(' | ')} |`
  return [line(rows[0]), rule, ...rows.slice(1).map(line)].join('\n')
}

/* ------------------------------------------------------------------ */
/* HTML (DOM)                                                          */
/* ------------------------------------------------------------------ */

const BREAK = '\uE000'

function cellText(cell: Element): string {
  const clone = cell.cloneNode(true) as Element
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(BREAK))
  clone.querySelectorAll('style, script').forEach((el) => el.remove())
  // Collapse source whitespace (Excel wraps long HTML lines) like a browser would; only <br>
  // (a line break typed in the cell) survives as a line break.
  return (clone.textContent ?? '')
    .replace(/[\s\u00a0]+/g, ' ')
    .split(BREAK)
    .map((part) => part.trim())
    .join('\n')
    .trim()
}

/** The cells of the first table, with merged cells spread out (their extra slots left empty). */
export function gridFromTable(table: HTMLTableElement): Grid {
  const grid: Grid = []
  const carry: number[] = [] // rows still covered by a rowspan, per column
  for (const tr of Array.from(table.rows)) {
    const row: string[] = []
    let col = 0
    const skipCovered = () => {
      while (carry[col] > 0) {
        carry[col]--
        row[col++] = ''
      }
    }
    for (const cell of Array.from(tr.cells)) {
      skipCovered()
      const text = cellText(cell)
      const colspan = Math.max(1, Math.min(cell.colSpan || 1, 100))
      const rowspan = Math.max(1, Math.min(cell.rowSpan || 1, 1000))
      for (let k = 0; k < colspan; k++) {
        row[col] = k === 0 ? text : ''
        if (rowspan > 1) carry[col] = rowspan - 1
        col++
      }
    }
    while (col < carry.length) {
      if (carry[col] > 0) {
        carry[col]--
        row[col] = ''
      }
      col++
    }
    grid.push(Array.from(row, (c) => c ?? ''))
  }
  return grid
}

interface HtmlInfo {
  /** Cells of the table, when the HTML is essentially one table (Excel, Sheets, a copied table). */
  grid: Grid | null
  /** Whether the HTML carries any text (rich text) rather than just images. */
  hasText: boolean
}

export function inspectHtml(html: string): HtmlInfo {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, title, meta').forEach((el) => el.remove())
  const body = doc.body
  const allText = (body?.textContent ?? '').replace(/\s+/g, '')
  const table = body?.querySelector('table')
  if (!table) return { grid: null, hasText: allText.length > 0 }
  // Only convert when the table is the content: a web page selection with paragraphs around a
  // table stays plain text rather than silently losing those paragraphs.
  const tableText = (table.textContent ?? '').replace(/\s+/g, '')
  const onlyTable = allText.length - tableText.length <= 0 && body.querySelectorAll('table').length === 1
  return { grid: onlyTable ? gridFromTable(table) : null, hasText: allText.length > 0 }
}

/* ------------------------------------------------------------------ */
/* Clipboard decision                                                  */
/* ------------------------------------------------------------------ */

export type PasteAction =
  | { kind: 'table'; markdown: string }
  | { kind: 'text'; text: string }
  | { kind: 'images'; files: File[] }
  | { kind: 'default' }

export function decidePaste(data: Pick<DataTransfer, 'getData' | 'files'>): PasteAction {
  const html = data.getData('text/html')
  const text = data.getData('text/plain')
  const images = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'))
  const info = html ? inspectHtml(html) : { grid: null, hasText: false }
  let grid = info.grid ? trimGrid(info.grid) : null
  // Spreadsheets that only offer tab-separated text next to their picture.
  if (!grid && !html && images.length && text.includes('\t')) grid = trimGrid(parseTsv(text))
  if (grid && cellCount(grid) > 1) return { kind: 'table', markdown: gridToMarkdown(grid) }
  // A single copied cell: its value, without the line break spreadsheets add.
  if (grid && cellCount(grid) === 1) return { kind: 'text', text: grid[0][0] }
  // Rich text (Word, a web page…) may come with a rendering of itself: paste the text.
  if (text.trim() && (info.hasText || !images.length)) return { kind: 'default' }
  if (images.length) return { kind: 'images', files: images }
  return { kind: 'default' }
}

/** Insert a block (a table) on lines of its own, with blank lines around it as Markdown needs. */
export function insertBlock(view: EditorView, block: string): void {
  const { state } = view
  const { from, to } = state.selection.main
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  const before = state.sliceDoc(startLine.from, from)
  const after = state.sliceDoc(to, endLine.to)
  let prefix = ''
  if (before.trim()) prefix = '\n\n'
  else if (startLine.number > 1 && state.doc.line(startLine.number - 1).text.trim()) prefix = '\n'
  // A line right below a table would be read as another row, so keep a blank line after it.
  const next = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1).text : null
  const suffix = after.trim() ? '\n\n' : next === null ? '\n' : next.trim() ? '\n' : ''
  const insert = prefix + block + suffix
  const cursor = from + prefix.length + block.length
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    userEvent: 'input.paste'
  })
}

/**
 * Paste handling for Markdown editors (code / plain-text files keep the default paste).
 * `onImages` receives pasted images; without it, image-only pastes are ignored as before.
 */
export function markdownPaste(onImages?: (view: EditorView, files: File[]) => void) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData
      if (!data || view.state.facet(language)?.name !== 'markdown') return false
      const action = decidePaste(data)
      switch (action.kind) {
        case 'table':
          event.preventDefault()
          insertBlock(view, action.markdown)
          return true
        case 'text':
          event.preventDefault()
          view.dispatch(view.state.replaceSelection(action.text), { userEvent: 'input.paste', scrollIntoView: true })
          return true
        case 'images':
          if (!onImages) return false
          event.preventDefault()
          onImages(view, action.files)
          return true
        default:
          return false
      }
    }
  })
}
