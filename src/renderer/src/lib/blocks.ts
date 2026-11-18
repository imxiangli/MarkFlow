/**
 * Source ranges of top-level Markdown blocks, for editing / showing one block at a time.
 * A block runs from its start line to the next block's start, minus trailing blank lines —
 * so definitions that render nothing (footnotes, link references, abbreviations) stay with
 * the block above them instead of being lost.
 */
export interface BlockRange {
  start: number
  /** Exclusive. */
  end: number
}

export function blockRange(blocks: number[], start: number, lines: string[]): BlockRange {
  const i = blocks.indexOf(start)
  let end = i >= 0 && i + 1 < blocks.length ? blocks[i + 1] : lines.length
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  return { start, end: Math.max(end, start) }
}

export function sliceLines(source: string, range: BlockRange): string {
  return source.split('\n').slice(range.start, range.end).join('\n')
}

/** Replace [start, end) with `text`; an empty text removes the block and its spacing. */
export function replaceLines(source: string, range: BlockRange, text: string): string {
  const lines = source.split('\n')
  const replacement = text.replace(/\s+$/, '')
  if (!replacement) {
    let end = range.end
    while (end < lines.length && lines[end].trim() === '') end++
    lines.splice(range.start, end - range.start)
    return lines.join('\n')
  }
  lines.splice(range.start, range.end - range.start, ...replacement.split('\n'))
  return lines.join('\n')
}

/** Append a new block at the end of the document, separated by a blank line. */
export function appendBlock(source: string, text: string): string {
  const body = text.replace(/\s+$/, '')
  if (!body) return source
  const trimmed = source.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n\n${body}\n` : `${body}\n`
}
