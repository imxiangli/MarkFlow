/** A Markdown heading found by a plain line scan (no rendering). */
export interface SourceHeading {
  /** 0-based line. */
  line: number
  level: number
  text: string
}

/** Strip the most common inline Markdown so headings read cleanly in lists. */
export function plainHeadingText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s*\{#[\w-]+\}\s*$/, '')
    .trim()
}

/**
 * ATX and setext headings of a Markdown document, skipping fenced code blocks and
 * front matter. Used by "Go to heading" (⌘R) and "Go to heading in folder" (⇧⌘R).
 */
export function extractHeadings(content: string, limit = Infinity): SourceHeading[] {
  const out: SourceHeading[] = []
  const lines = content.split(/\r?\n/)
  let fence: string | null = null
  let start = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) start = end + 1
  }
  for (let i = start; i < lines.length && out.length < limit; i++) {
    const line = lines[i]
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const m = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*$/.exec(line)
    if (m) {
      const text = plainHeadingText((m[2] ?? '').replace(/\s+#+$/, ''))
      if (text) out.push({ line: i, level: m[1].length, text })
      continue
    }
    // Setext: a non-blank paragraph line underlined with === or ---.
    const next = lines[i + 1]
    if (next !== undefined && line.trim() && !/^\s{4,}/.test(line) && /^\s{0,3}(=+|-+)\s*$/.test(next)) {
      const prev = lines[i - 1]
      const startsParagraph = i === start || prev === undefined || !prev.trim()
      if (startsParagraph && !/^\s{0,3}([-*+>]|\d+[.)])\s/.test(line) && !line.includes('|')) {
        out.push({ line: i, level: next.trim()[0] === '=' ? 1 : 2, text: plainHeadingText(line.trim()) })
        i++
      }
    }
  }
  return out
}
