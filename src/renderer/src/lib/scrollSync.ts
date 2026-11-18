import { editorBridge } from '@/editor/bridge'

/**
 * Bidirectional scroll synchronisation between the editor and the preview,
 * based on the data-line attributes emitted by the Markdown renderer.
 */

interface Anchor {
  line: number
  top: number
}

let previewScroller: HTMLElement | null = null
let previewContent: HTMLElement | null = null
let anchors: Anchor[] | null = null
let driver: 'editor' | 'preview' | null = null
let enabled = () => false
let frame = 0
let trailing = 0

export function configureScrollSync(isEnabled: () => boolean): void {
  enabled = isEnabled
}

export function setPreviewElements(scroller: HTMLElement | null, content: HTMLElement | null): void {
  previewScroller = scroller
  previewContent = content
  anchors = null
}

export function invalidateAnchors(): void {
  anchors = null
}

/** Called on pointer/wheel/keyboard activity so only the pane the user drives is followed. */
export function setDriver(d: 'editor' | 'preview'): void {
  driver = d
}

function collectAnchors(): Anchor[] {
  if (anchors) return anchors
  const out: Anchor[] = []
  if (previewContent && previewScroller) {
    const base = previewScroller.getBoundingClientRect().top - previewScroller.scrollTop
    for (const el of previewContent.querySelectorAll<HTMLElement>('[data-line]')) {
      const line = Number(el.getAttribute('data-line'))
      if (!Number.isFinite(line)) continue
      // Skip hidden elements (e.g. inside closed <details>).
      if (!el.offsetParent && el.tagName !== 'DETAILS') continue
      out.push({ line, top: el.getBoundingClientRect().top - base })
    }
  }
  out.sort((a, b) => a.line - b.line || a.top - b.top)
  // Keep a strictly increasing mapping.
  const mono: Anchor[] = []
  for (const a of out) {
    const prev = mono[mono.length - 1]
    if (prev && (a.line === prev.line || a.top <= prev.top)) continue
    mono.push(a)
  }
  anchors = mono
  return mono
}

function lineToPreviewTop(line: number): number {
  const list = collectAnchors()
  if (!list.length || !previewScroller) return 0
  if (line <= list[0].line) return list[0].top * (line / Math.max(1, list[0].line))
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const b = list[i + 1]
    if (!b) {
      const end = previewScroller.scrollHeight
      return a.top + Math.min(1, line - a.line) * Math.max(0, Math.min(end - a.top, 200))
    }
    if (line < b.line) return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top)
  }
  return 0
}

function previewTopToLine(top: number): number {
  const list = collectAnchors()
  if (!list.length) return 0
  if (top <= list[0].top) return list[0].line * (top / Math.max(1, list[0].top))
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const b = list[i + 1]
    if (!b) return a.line
    if (top < b.top) return a.line + ((top - a.top) / (b.top - a.top)) * (b.line - a.line)
  }
  return list[list.length - 1].line
}

function syncFromEditor(): void {
  if (!previewScroller) return
  if (editorBridge.atBottom()) {
    previewScroller.scrollTop = previewScroller.scrollHeight
    return
  }
  previewScroller.scrollTop = Math.max(0, lineToPreviewTop(editorBridge.topLine()) - 12)
}

function syncFromPreview(): void {
  const s = previewScroller
  if (!s) return
  if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) {
    editorBridge.scrollToBottom()
    return
  }
  editorBridge.scrollToLine(previewTopToLine(s.scrollTop + 12))
}

/**
 * Coalesce scroll events into one sync per frame, plus a trailing sync once scrolling
 * settles (CodeMirror refines line heights after rendering, shifting positions slightly).
 * Feedback loops are avoided because only the pane the user is driving propagates.
 */
function schedule(from: 'editor' | 'preview'): void {
  if (!enabled() || driver !== from) return
  const run = () => {
    if (driver === from) (from === 'editor' ? syncFromEditor : syncFromPreview)()
  }
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(run)
  clearTimeout(trailing)
  trailing = window.setTimeout(run, 140)
}

export function onEditorScroll(): void {
  schedule('editor')
}

export function onPreviewScroll(): void {
  schedule('preview')
}

/** Scroll the preview so that the given source line is visible near the top. */
export function scrollPreviewToLine(line: number, smooth = false): void {
  if (!previewScroller) return
  const top = Math.max(0, lineToPreviewTop(line) - 16)
  previewScroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
}

export function previewTopLine(): number {
  if (!previewScroller) return 0
  return previewTopToLine(previewScroller.scrollTop + 12)
}
