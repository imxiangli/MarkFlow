/**
 * Row / column editing of GFM tables in Markdown source. Pure functions over the table's lines
 * (no imports), so they can be unit tested in Node:  npm run test:table
 *
 * Lines are addressed as in the source: 0 is the header, 1 the delimiter row, 2… the body rows.
 * Every edit re-formats the table with aligned columns.
 */

export type Align = 'left' | 'center' | 'right' | null

export interface TableModel {
  /** Blockquote / list indentation in front of every line ("> ", "  "). */
  prefix: string
  header: string[]
  aligns: Align[]
  rows: string[][]
}

export type TableOp =
  | 'rowAbove'
  | 'rowBelow'
  | 'rowUp'
  | 'rowDown'
  | 'deleteRow'
  | 'colLeft'
  | 'colRight'
  | 'colMoveLeft'
  | 'colMoveRight'
  | 'deleteCol'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignNone'
  | 'format'

export interface TableEdit {
  /** The new table source. */
  text: string
  /** Where the caret goes: line within the table and offset in that line. */
  line: number
  ch: number
}

/** Display width with CJK / full-width characters counted twice (same rule as pasted tables). */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}

const PREFIX = /^(?:[ \t]*>)*[ \t]*/

/** Cells of one row; escaped pipes (\|) stay escaped and inside their cell. */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1]
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':') && cell.length > 1
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null
}

const DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

export function isDelimiterRow(line: string): boolean {
  const s = line.replace(PREFIX, '').trim()
  // A bare "---" under a line is a setext heading, not a one-column table.
  return s.includes('|') && DELIMITER.test(s)
}

export function parseTable(lines: string[]): TableModel | null {
  if (lines.length < 2 || !isDelimiterRow(lines[1])) return null
  const prefix = PREFIX.exec(lines[0])![0]
  const strip = (line: string) => (line.startsWith(prefix) ? line.slice(prefix.length) : line.replace(PREFIX, ''))
  const header = splitRow(strip(lines[0]))
  const aligns = splitRow(strip(lines[1])).map(parseAlign)
  const rows = lines.slice(2).map((l) => splitRow(strip(l)))
  // Never drop cells: the table is as wide as its widest row.
  const width = Math.max(header.length, aligns.length, ...rows.map((r) => r.length))
  const fill = <T>(arr: T[], value: T) => {
    while (arr.length < width) arr.push(value)
    return arr
  }
  return { prefix, header: fill(header, ''), aligns: fill(aligns, null), rows: rows.map((r) => fill(r, '')) }
}

export function renderTable(t: TableModel): string[] {
  const n = t.header.length
  const widths = Array.from({ length: n }, (_, c) => Math.max(3, displayWidth(t.header[c]), ...t.rows.map((r) => displayWidth(r[c]))))
  const pad = (s: string, c: number) => {
    const space = widths[c] - displayWidth(s)
    if (t.aligns[c] === 'right') return ' '.repeat(space) + s
    if (t.aligns[c] === 'center') {
      const left = Math.floor(space / 2)
      return ' '.repeat(left) + s + ' '.repeat(space - left)
    }
    return s + ' '.repeat(space)
  }
  const rule = widths.map((w, c) => {
    const a = t.aligns[c]
    if (a === 'center') return `:${'-'.repeat(w - 2)}:`
    if (a === 'left') return `:${'-'.repeat(w - 1)}`
    if (a === 'right') return `${'-'.repeat(w - 1)}:`
    return '-'.repeat(w)
  })
  const line = (cells: string[]) => `${t.prefix}| ${cells.map(pad).join(' | ')} |`
  return [line(t.header), `${t.prefix}| ${rule.join(' | ')} |`, ...t.rows.map(line)]
}

/** Column under offset `ch` of a table line (0-based, clamped to the table). */
export function columnAt(line: string, ch: number, columns: number): number {
  const body = line.replace(PREFIX, '')
  const start = line.length - body.length
  let pipes = 0
  for (let i = start; i < Math.min(ch, line.length); i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '|') pipes++
  }
  const col = body.startsWith('|') ? pipes - 1 : pipes
  return Math.max(0, Math.min(columns - 1, col))
}

/** Offset of the content of column `col` in a line written by renderTable. */
function cellStart(line: string, col: number): number {
  let pipes = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '|' && ++pipes === col + 1) return Math.min(line.length, i + 2)
  }
  return line.length
}

const swap = <T>(arr: T[], a: number, b: number) => {
  ;[arr[a], arr[b]] = [arr[b], arr[a]]
}

/**
 * Apply `op` with the caret on table line `line`, column `col`. Returns null when the operation
 * doesn't apply there (e.g. deleting the header row or the only column).
 */
export function editTable(lines: string[], line: number, col: number, op: TableOp): TableEdit | null {
  const t = parseTable(lines)
  if (!t) return null
  const width = t.header.length
  col = Math.max(0, Math.min(width - 1, col))
  // The delimiter row counts as part of the header.
  const body = line >= 2 ? line - 2 : -1
  const empty = () => Array.from({ length: t.header.length }, () => '')
  let toLine = line <= 1 ? 0 : line
  let toCol = col
  switch (op) {
    case 'rowAbove':
      if (body < 0) return null
      t.rows.splice(body, 0, empty())
      break
    case 'rowBelow':
      t.rows.splice(body + 1, 0, empty())
      toLine = body + 3
      break
    case 'rowUp':
      if (body < 1) return null
      swap(t.rows, body, body - 1)
      toLine = line - 1
      break
    case 'rowDown':
      if (body < 0 || body >= t.rows.length - 1) return null
      swap(t.rows, body, body + 1)
      toLine = line + 1
      break
    case 'deleteRow':
      if (body < 0) return null
      t.rows.splice(body, 1)
      toLine = t.rows.length ? Math.min(line, t.rows.length + 1) : 0
      break
    case 'colLeft':
    case 'colRight': {
      const at = op === 'colLeft' ? col : col + 1
      t.header.splice(at, 0, '')
      t.aligns.splice(at, 0, null)
      for (const r of t.rows) r.splice(at, 0, '')
      toCol = at
      break
    }
    case 'colMoveLeft':
    case 'colMoveRight': {
      const other = op === 'colMoveLeft' ? col - 1 : col + 1
      if (other < 0 || other >= width) return null
      for (const arr of [t.header, t.aligns, ...t.rows] as unknown[][]) swap(arr, col, other)
      toCol = other
      break
    }
    case 'deleteCol':
      if (width <= 1) return null
      t.header.splice(col, 1)
      t.aligns.splice(col, 1)
      for (const r of t.rows) r.splice(col, 1)
      toCol = Math.min(col, width - 2)
      break
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight':
    case 'alignNone':
      t.aligns[col] = op === 'alignLeft' ? 'left' : op === 'alignCenter' ? 'center' : op === 'alignRight' ? 'right' : null
      break
    case 'format':
      break
  }
  const out = renderTable(t)
  return { text: out.join('\n'), line: toLine, ch: cellStart(out[toLine], toCol) }
}

/** Alignment of column `col`, for check marks. */
export function alignOf(lines: string[], col: number): Align {
  return parseTable(lines)?.aligns[col] ?? null
}

/**
 * Lines of the table that starts at `start` (its header row), for sources without a syntax tree
 * (the preview): rows continue until a blank line or a line without a pipe.
 */
export function tableEnd(lines: string[], start: number): number {
  let end = start + 2
  while (end < lines.length && lines[end].trim() && lines[end].includes('|')) end++
  return end
}
