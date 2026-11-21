import type { Extension, Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { highlightTree, type Highlighter } from '@lezer/highlight'

/**
 * Sublime-style minimap: a scaled-down picture of the document on the right edge of the
 * editor. The shaded slider marks what the editor shows; drag it to scroll, click elsewhere
 * to jump there, and the wheel scrolls the editor.
 *
 * The picture is the editor's own height map scaled by `s` (one text row = ROW px), so
 * wrapped lines, headings and folds take the same relative room as in the editor. When the
 * scaled document is taller than the editor, the minimap itself scrolls in proportion.
 */

/** Width of the minimap in CSS pixels. */
const WIDTH = 100
/** Height of one row of text in the minimap. */
const ROW = 3
/** Below this editor width the minimap would crowd the text, so it is hidden. */
const MIN_EDITOR_WIDTH = 480
/** Characters drawn per line at most (the rest wouldn't fit anyway). */
const MAX_CHARS = 2000

interface Metrics {
  hidden: boolean
  top: number
  height: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** Scroller offset of the document's first line (content padding). */
  docOffset: number
  /** Columns per editor row when lines wrap (0 = no wrapping). */
  wrapColumns: number
  scale: number
  charWidth: number
  dpr: number
  textColor: string
  theme: string
  /** Minimap scroll offset. */
  offset: number
  /** Lines to draw: document range, minimap y and height. */
  lines: { from: number; to: number; y: number; height: number }[]
  spans: Span[]
}

interface Span {
  from: number
  to: number
  color: string
}

/** East Asian wide characters take two columns, like in the editor. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  )
}

function columnsOf(text: string, tabSize: number): number {
  let col = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 9) col += tabSize - (col % tabSize)
    else if (code >= 0xdc00 && code <= 0xdfff) continue
    else col += code >= 0xd800 && code <= 0xdbff ? 2 : isWide(code) ? 2 : 1
  }
  return col
}

class Minimap {
  dom: HTMLElement
  private canvas: HTMLCanvasElement
  private slider: HTMLElement
  private probe: HTMLElement
  private metrics: Metrics | null = null
  private colors = new Map<string, string>()
  private colorTheme = ''
  private drag: { startY: number; startScroll: number; ratio: number } | null = null
  private themeObserver: MutationObserver

  constructor(
    readonly view: EditorView,
    readonly highlighter: Highlighter
  ) {
    this.dom = document.createElement('div')
    this.dom.className = 'cm-minimap'
    this.dom.setAttribute('aria-hidden', 'true')
    this.canvas = document.createElement('canvas')
    this.slider = document.createElement('div')
    this.slider.className = 'cm-minimap-slider'
    this.probe = document.createElement('span')
    this.probe.style.display = 'none'
    this.dom.append(this.canvas, this.slider, this.probe)
    view.dom.appendChild(this.dom)

    this.dom.addEventListener('pointerdown', this.onPointerDown)
    this.dom.addEventListener('pointermove', this.onPointerMove)
    this.dom.addEventListener('pointerup', this.onPointerUp)
    this.dom.addEventListener('pointercancel', this.onPointerUp)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    view.scrollDOM.addEventListener('scroll', this.onScroll)
    // Colours come from CSS variables: redraw when the theme changes.
    this.themeObserver = new MutationObserver(() => this.schedule())
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    this.schedule()
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.heightChanged ||
      syntaxTree(update.state) !== syntaxTree(update.startState)
    )
      this.schedule()
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.view.scrollDOM.style.marginRight = ''
    this.themeObserver.disconnect()
    this.dom.remove()
  }

  private onScroll = (): void => this.schedule()

  schedule(): void {
    this.view.requestMeasure({ key: this, read: () => this.read(), write: (m) => this.write(m) })
  }

  private read(): Metrics {
    const view = this.view
    const sd = view.scrollDOM
    const lineHeight = view.defaultLineHeight || 20
    const charWidth = view.defaultCharacterWidth || 8
    const scale = ROW / lineHeight
    const hidden = view.dom.clientWidth < MIN_EDITOR_WIDTH
    const contentStyle = getComputedStyle(view.contentDOM)
    const lineEl = view.contentDOM.querySelector<HTMLElement>('.cm-line')
    const linePadding = lineEl
      ? parseFloat(getComputedStyle(lineEl).paddingLeft) + parseFloat(getComputedStyle(lineEl).paddingRight)
      : 0
    const m: Metrics = {
      hidden,
      top: sd.offsetTop,
      height: sd.clientHeight,
      scrollTop: sd.scrollTop,
      scrollHeight: sd.scrollHeight,
      clientHeight: sd.clientHeight,
      docOffset: view.documentTop - sd.getBoundingClientRect().top + sd.scrollTop,
      wrapColumns: view.lineWrapping
        ? Math.max(10, Math.floor((view.contentDOM.clientWidth - linePadding) / charWidth))
        : 0,
      scale,
      charWidth: charWidth * scale,
      dpr: window.devicePixelRatio || 1,
      textColor: contentStyle.color,
      theme: document.documentElement.dataset.theme ?? '',
      offset: 0,
      lines: [],
      spans: []
    }
    if (!hidden) this.collect(m)
    return m
  }

  /** Lines in the minimap's visible part and their syntax colours (layout reads: measure phase only). */
  private collect(m: Metrics): void {
    const view = this.view
    const state = view.state
    const doc = state.doc
    const offset = (m.offset = this.minimapScroll(m))
    const toHeight = (offset + m.height) / m.scale - m.docOffset
    if (toHeight < 0) return
    const first = view.lineBlockAtHeight(Math.max(0, offset / m.scale - m.docOffset))
    const end = Math.min(view.lineBlockAtHeight(toHeight).to, doc.length)
    for (let pos = first.from; pos <= end; ) {
      const block = view.lineBlockAt(pos)
      const y = (block.top + m.docOffset) * m.scale - offset
      if (y > m.height) break
      const height = block.height * m.scale
      if (y + height >= 0) {
        const line = doc.lineAt(block.from)
        m.lines.push({ from: line.from, to: Math.min(line.to, line.from + MAX_CHARS), y, height })
      }
      if (block.to >= doc.length) break
      pos = block.to + 1
    }
    if (!m.lines.length) return
    // Only what the parser has reached so far is coloured.
    highlightTree(
      syntaxTree(state),
      this.highlighter,
      (from, to, classes) => m.spans.push({ from, to, color: this.colorFor(classes, m) }),
      m.lines[0].from,
      m.lines[m.lines.length - 1].to
    )
  }

  /** Scroll position of the minimap itself (when the scaled document is taller than it). */
  private minimapScroll(m: Metrics): number {
    const overflow = m.scrollHeight * m.scale - m.height
    if (overflow <= 0) return 0
    const maxScroll = m.scrollHeight - m.clientHeight
    return maxScroll > 0 ? overflow * Math.min(1, Math.max(0, m.scrollTop / maxScroll)) : 0
  }

  private write(m: Metrics): void {
    this.metrics = m
    this.dom.style.display = m.hidden ? 'none' : ''
    this.view.scrollDOM.style.marginRight = m.hidden ? '' : `${WIDTH}px`
    if (m.hidden) return
    this.dom.style.top = `${m.top}px`
    this.dom.style.height = `${m.height}px`

    const offset = m.offset
    const sliderHeight = Math.min(m.height, Math.max(8, m.clientHeight * m.scale))
    const sliderTop = Math.max(0, Math.min(m.height - sliderHeight, m.scrollTop * m.scale - offset))
    this.slider.style.top = `${sliderTop}px`
    this.slider.style.height = `${sliderHeight}px`
    this.draw(m)
  }

  private colorFor(classes: string, m: Metrics): string {
    if (this.colorTheme !== m.theme) {
      this.colors.clear()
      this.colorTheme = m.theme
    }
    let color = this.colors.get(classes)
    if (color === undefined) {
      this.probe.className = classes
      color = getComputedStyle(this.probe).color || m.textColor
      this.colors.set(classes, color)
    }
    return color
  }

  private draw(m: Metrics): void {
    const { view, canvas } = this
    const width = Math.round(WIDTH * m.dpr)
    const height = Math.round(m.height * m.dpr)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      canvas.style.width = `${WIDTH}px`
      canvas.style.height = `${m.height}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0)
    ctx.clearRect(0, 0, WIDTH, m.height)
    ctx.globalAlpha = 0.7
    const doc = view.state.doc
    const tabSize = view.state.tabSize
    let spanIndex = 0
    for (const line of m.lines) {
      while (spanIndex < m.spans.length && m.spans[spanIndex].to <= line.from) spanIndex++
      this.drawLine(ctx, doc, line.from, line.to, line.y, line.height, m, m.spans, spanIndex, tabSize)
    }
    ctx.globalAlpha = 1
  }

  private drawLine(
    ctx: CanvasRenderingContext2D,
    doc: Text,
    from: number,
    to: number,
    y: number,
    blockHeight: number,
    m: Metrics,
    spans: Span[],
    spanIndex: number,
    tabSize: number
  ): void {
    const text = doc.sliceString(from, to)
    if (!text.trim()) return
    const wrap = m.wrapColumns
    const rows = wrap ? Math.max(1, Math.ceil(columnsOf(text, tabSize) / wrap)) : 1
    const rowHeight = blockHeight / rows
    const glyph = Math.max(1, rowHeight * 0.66)
    const maxColumns = wrap || Math.ceil(WIDTH / m.charWidth)
    const left = 2

    let col = 0
    let row = 0
    let runStart = -1
    let runColor = ''
    let i = 0
    const flush = (endCol: number) => {
      if (runStart < 0) return
      ctx.fillStyle = runColor
      ctx.fillRect(left + runStart * m.charWidth, y + row * rowHeight, (endCol - runStart) * m.charWidth, glyph)
      runStart = -1
    }
    for (; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0xdc00 && code <= 0xdfff) continue
      const width = code === 9 ? tabSize - (col % tabSize) : code >= 0xd800 && code <= 0xdbff ? 2 : isWide(code) ? 2 : 1
      if (col + width > maxColumns && col > 0) {
        flush(col)
        if (!wrap) return
        row++
        col = 0
        if (row >= rows) return
      }
      const space = code === 32 || code === 9 || code === 0xa0 || code === 0x3000
      if (space) flush(col)
      else {
        const pos = from + i
        while (spanIndex < spans.length && spans[spanIndex].to <= pos) spanIndex++
        const span = spans[spanIndex]
        const color = span && span.from <= pos ? span.color : m.textColor
        if (runStart >= 0 && color !== runColor) flush(col)
        if (runStart < 0) {
          runStart = col
          runColor = color
        }
      }
      col += width
    }
    flush(col)
  }

  // ---- Mouse

  /** Editor pixels scrolled per minimap pixel dragged, as the slider follows the pointer. */
  private dragRatio(m: Metrics): number {
    const sliderHeight = Math.min(m.height, m.clientHeight * m.scale)
    const maxScroll = m.scrollHeight - m.clientHeight
    if (m.scrollHeight * m.scale <= m.height || maxScroll <= 0) return m.scale
    const track = m.height - sliderHeight
    return track > 0 ? track / maxScroll : m.scale
  }

  private onPointerDown = (e: PointerEvent): void => {
    const m = this.metrics
    if (e.button !== 0 || !m) return
    e.preventDefault()
    const sd = this.view.scrollDOM
    const y = e.clientY - this.dom.getBoundingClientRect().top
    const sliderTop = this.slider.offsetTop
    const onSlider = y >= sliderTop && y <= sliderTop + this.slider.offsetHeight
    if (!onSlider) {
      // Jump so the clicked spot is in the middle of the editor, then keep dragging from there.
      const target = (y + this.minimapScroll(m)) / m.scale - m.clientHeight / 2
      sd.scrollTop = Math.max(0, Math.min(target, m.scrollHeight - m.clientHeight))
    }
    this.drag = { startY: e.clientY, startScroll: sd.scrollTop, ratio: this.dragRatio(m) }
    this.dom.setPointerCapture(e.pointerId)
    this.dom.classList.add('cm-minimap-dragging')
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return
    e.preventDefault()
    this.view.scrollDOM.scrollTop = this.drag.startScroll + (e.clientY - this.drag.startY) / this.drag.ratio
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return
    this.drag = null
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId)
    this.dom.classList.remove('cm-minimap-dragging')
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const unit = e.deltaMode === 1 ? this.view.defaultLineHeight : e.deltaMode === 2 ? this.view.scrollDOM.clientHeight : 1
    this.view.scrollDOM.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit })
  }
}

const minimapTheme = EditorView.baseTheme({
  '.cm-minimap': {
    position: 'absolute',
    right: '0',
    width: `${WIDTH}px`,
    overflow: 'hidden',
    zIndex: '2',
    cursor: 'default',
    userSelect: 'none',
    touchAction: 'none'
  },
  '.cm-minimap canvas': { display: 'block' },
  '.cm-minimap-slider': {
    position: 'absolute',
    left: '0',
    right: '0',
    backgroundColor: 'var(--minimap-slider, rgba(128, 128, 128, 0.14))',
    transition: 'background-color 0.12s'
  },
  '.cm-minimap:hover .cm-minimap-slider, .cm-minimap-dragging .cm-minimap-slider': {
    backgroundColor: 'var(--minimap-slider-hover, rgba(128, 128, 128, 0.24))'
  }
})

/** The minimap, coloured with the editor's syntax highlighter. */
export function minimap(highlighter: Highlighter): Extension {
  return [ViewPlugin.define((view) => new Minimap(view, highlighter)), minimapTheme]
}
