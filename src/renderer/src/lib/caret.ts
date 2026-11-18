/**
 * Best guess of the source offset the user clicked on inside rendered Markdown: take the text
 * just before the click point and find it in the block's source.
 */
export function caretHint(source: string, x: number, y: number): number {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (!pos || pos.offsetNode.nodeType !== Node.TEXT_NODE) return -1
  const text = pos.offsetNode.textContent ?? ''
  const before = text.slice(0, pos.offset)
  for (let len = Math.min(24, before.length); len >= 2; len--) {
    const snippet = before.slice(-len)
    const idx = source.indexOf(snippet)
    if (idx >= 0) return idx + len
  }
  // Clicked at the very start of a text node: look for what follows instead.
  const after = text.slice(pos.offset, pos.offset + 12)
  for (let len = Math.min(12, after.length); len >= 2; len--) {
    const idx = source.indexOf(after.slice(0, len))
    if (idx >= 0) return idx
  }
  return -1
}
