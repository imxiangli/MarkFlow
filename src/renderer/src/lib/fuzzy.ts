/** Pure helpers behind the palette (⌘P / ⇧⌘P / ⌘R / ⌃G), kept DOM-free for unit tests. */

/** Subsequence fuzzy score; higher is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const s = text.toLowerCase()
  let score = 0
  let qi = 0
  let prev = -2
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue
    let bonus = 1
    if (i === prev + 1) bonus += 4
    const before = s[i - 1]
    if (i === 0 || before === '/' || before === '\\' || before === '-' || before === '_' || before === ' ' || before === '.') bonus += 3
    score += bonus
    prev = i
    qi++
  }
  if (qi < q.length) return -1
  const name = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1)
  if (name.includes(q)) score += 10 + (name.startsWith(q) ? 8 : 0)
  return score - s.length * 0.01
}

export type PaletteMode = 'files' | 'commands' | 'headings' | 'project' | 'line'

/** Sublime's Goto Anything prefixes: ">" commands, "@" headings, "#" folder headings, ":" line. */
export function paletteMode(query: string): PaletteMode {
  switch (query[0]) {
    case '>':
      return 'commands'
    case '@':
      return 'headings'
    case '#':
      return 'project'
    case ':':
      return 'line'
    default:
      return 'files'
  }
}

/** "readme:12:4" → file "readme", line 12, column 4; "readme@intro" → heading "intro". */
export function parseFileQuery(query: string): { file: string; line?: number; column?: number; heading?: string } {
  const at = /^(.+?)@(.*)$/.exec(query)
  if (at) return { file: at[1], heading: at[2] }
  const ln = /^(.+?):(\d+)(?::(\d+))?$/.exec(query)
  if (ln) return { file: ln[1], line: Number(ln[2]), column: ln[3] ? Number(ln[3]) : undefined }
  return { file: query }
}

/** Items ordered by fuzzy score (ties keep their original order). */
export function rank<T>(items: T[], query: string, text: (it: T) => string, limit = 120): T[] {
  if (!query) return items.slice(0, limit)
  return items
    .map((it, i) => ({ it, i, score: fuzzyScore(query, text(it)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it)
}
