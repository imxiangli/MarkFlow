import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Code2, Copy, Crosshair, Eye, Maximize2, PenLine, Plus } from 'lucide-react'
import { followLink, openWikilink, registerBlockEditFlush, registerPreviewWaiter, updateContent } from '@/actions'
import { editorBridge } from '@/editor/bridge'
import { toggleTaskInSource } from '@/editor/commands'
import { appendBlock, blockRange, replaceLines, type BlockRange } from '@/lib/blocks'
import { useT } from '@/lib/i18n'
import { basename } from '@/lib/path'
import {
  invalidateAnchors,
  onPreviewScroll,
  scrollPreviewToLine,
  setDriver,
  setPreviewElements
} from '@/lib/scrollSync'
import { renderMarkdown } from '@/markdown/md'
import { patchPreview, renderPendingDiagrams, type SourceBlock } from '@/markdown/preview-dom'
import type { DiagramContext } from '@/markdown/diagrams'
import { activeTab, getState, resolvedTheme, setState, toast, useStore } from '@/store'
import { BlockEditor } from './BlockEditor'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { clipboardKey, copyImage, revealLabel } from '@/editor/contextMenu'
import { ASSET_SCHEME } from '@shared/constants'

const scrollPositions = new Map<string, number>()
/** Per tab: start lines of blocks currently shown as Markdown source. */
const sourceToggles = new Map<string, Set<number>>()

function waitForImages(root: HTMLElement, timeout = 4000): Promise<void> {
  const imgs = [...root.querySelectorAll('img')].filter((img) => !img.complete)
  if (!imgs.length) return Promise.resolve()
  return new Promise((resolve) => {
    let left = imgs.length
    const done = () => {
      if (--left <= 0) resolve()
    }
    imgs.forEach((img) => {
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    })
    setTimeout(resolve, timeout)
  })
}

interface EditState {
  tabId: string
  range: BlockRange
  original: string
  cursor: number
  append: boolean
  host: HTMLElement
  hidden: HTMLElement[]
}

interface HoverState {
  start: number
  top: number
  left: number
  zoomable: boolean
}

/** The top-level element (rendered block or its source view) that contains `node`. */
function topBlockOf(node: Element | null, body: HTMLElement | null): HTMLElement | null {
  let el = node as HTMLElement | null
  while (el && el.parentElement !== body) el = el.parentElement
  if (!el || !body) return null
  return el.hasAttribute('data-block-start') || el.hasAttribute('data-source-of') ? el : null
}

function blockStartOf(el: HTMLElement): number {
  return Number(el.getAttribute('data-block-start') ?? el.getAttribute('data-source-of'))
}

/** Local file behind a preview image URL (mf-asset://local/…), or null for remote / inline images. */
function assetPath(src: string): string | null {
  const prefix = `${ASSET_SCHEME}://local`
  if (!src.startsWith(prefix)) return null
  try {
    const p = decodeURIComponent(new URL(src).pathname)
    return /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p
  } catch {
    return null
  }
}

/** Best guess of where in the block source the user double-clicked. */
function caretHint(source: string, x: number, y: number): number {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (!pos || pos.offsetNode.nodeType !== Node.TEXT_NODE) return -1
  const before = (pos.offsetNode.textContent ?? '').slice(0, pos.offset)
  for (let len = Math.min(24, before.length); len >= 3; len--) {
    const snippet = before.slice(-len)
    const idx = source.indexOf(snippet)
    if (idx >= 0) return idx + len
  }
  return -1
}

export function Preview({ visible }: { visible: boolean }) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLElement>(null)
  const tab = useStore((s) => activeTab(s))
  const locale = useStore((s) => s.locale)
  const theme = useStore((s) => resolvedTheme(s))
  const root = useStore((s) => s.root)
  const plantumlEnabled = useStore((s) => s.settings.enablePlantUML)
  const plantumlServer = useStore((s) => s.settings.plantumlServer)
  const dblclickToEdit = useStore((s) => s.settings.dblclickToEdit)
  const viewMode = useStore((s) => s.viewMode)
  const reveal = useStore((s) => s.reveal)
  const [renderSeq, setRenderSeq] = useState(0)
  const [sourceSeq, setSourceSeq] = useState(0)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const editingRef = useRef<EditState | null>(null)
  const editorText = useRef<() => string>(() => '')
  const rendered = useRef<{ tabId: string; key: string } | null>(null)
  const idle = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
  const handledReveal = useRef(0)
  const headingEls = useRef<HTMLElement[]>([])
  const blocksRef = useRef<number[]>([])
  /** Set when a block edit is committed so the result shows without the typing debounce. */
  const renderNow = useRef(false)

  const tabId = tab?.kind === 'markdown' ? tab.id : null
  const content = tab?.kind === 'markdown' ? tab.content : ''
  const filePath = tab?.path ?? null
  editingRef.current = editing

  useEffect(() => {
    setPreviewElements(scrollRef.current, bodyRef.current)
    registerPreviewWaiter(async () => {
      await (idle.current?.promise ?? Promise.resolve())
      if (bodyRef.current) await waitForImages(bodyRef.current)
    })
    const ro = new ResizeObserver(() => invalidateAnchors())
    const body = bodyRef.current
    // "toggle" does not bubble, so listen in the capture phase.
    const onToggle = (e: Event) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'DETAILS') el.setAttribute('data-user-toggled', '1')
      invalidateAnchors()
    }
    if (body) {
      ro.observe(body)
      body.addEventListener('toggle', onToggle, true)
    }
    return () => {
      ro.disconnect()
      body?.removeEventListener('toggle', onToggle, true)
      registerPreviewWaiter(null)
      setPreviewElements(null, null)
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  // Render (debounced while typing, immediate on tab switch). Paused while a block is edited.
  useEffect(() => {
    if (!visible || !tabId || !bodyRef.current || editing) return
    const toggles = sourceToggles.get(tabId)
    const key = `${content.length}|${theme}|${locale}|${plantumlEnabled}|${plantumlServer}|${filePath}|${root}|${sourceSeq}`
    const prev = rendered.current
    const switching = !prev || prev.tabId !== tabId
    if (!switching && prev.key === key + '|' + content) return
    if (!idle.current) {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      idle.current = { promise, resolve }
    }
    const delay = switching || renderNow.current ? 0 : content.length > 300_000 ? 350 : 110
    renderNow.current = false
    const timer = window.setTimeout(() => {
      const body = bodyRef.current!
      const scroller = scrollRef.current!
      if (switching && prev) scrollPositions.set(prev.tabId, scroller.scrollTop)
      const ctx: DiagramContext = {
        theme,
        plantumlEnabled,
        plantumlServer,
        width: body.clientWidth - 2,
        messages: { error: t('preview.diagramError'), plantumlDisabled: t('preview.plantumlDisabled') }
      }
      let headings: ReturnType<typeof renderMarkdown>['headings'] = []
      try {
        const result = renderMarkdown(content, locale)
        headings = result.headings
        blocksRef.current = result.blocks
        const lines = content.split('\n')
        const sourceBlocks: SourceBlock[] = []
        for (const start of toggles ?? []) {
          if (!result.blocks.includes(start)) {
            toggles?.delete(start)
            continue
          }
          const r = blockRange(result.blocks, start, lines)
          sourceBlocks.push({ start, source: lines.slice(r.start, r.end).join('\n') })
        }
        patchPreview(body, result.html, {
          filePath,
          root,
          copyLabel: t('preview.copy'),
          diagram: ctx,
          sourceBlocks,
          sourceLabels: { title: t('block.sourceLabel'), exit: t('block.rendered') }
        })
      } catch (err) {
        body.textContent = String(err)
      }
      rendered.current = { tabId, key: key + '|' + content }
      headingEls.current = [...body.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')]
      setState({ headings })
      setHover(null)
      invalidateAnchors()
      if (switching) scroller.scrollTop = scrollPositions.get(tabId) ?? 0
      setRenderSeq((n) => n + 1)
      window.dispatchEvent(new Event('mf-preview-rendered'))
      void renderPendingDiagrams(body, ctx).then((changed) => {
        if (changed) {
          invalidateAnchors()
          window.dispatchEvent(new Event('mf-preview-rendered'))
        }
        if (rendered.current?.key === key + '|' + content) {
          idle.current?.resolve()
          idle.current = null
        }
      })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [visible, tabId, content, theme, locale, plantumlEnabled, plantumlServer, filePath, root, t, sourceSeq, editing])

  // Scroll to a heading / line on request (outline clicks, search results, links).
  useEffect(() => {
    if (!reveal || !visible || reveal.seq === handledReveal.current || reveal.tabId !== tabId) return
    if (rendered.current?.tabId !== tabId) return
    handledReveal.current = reveal.seq
    const body = bodyRef.current
    const scroller = scrollRef.current
    if (!body || !scroller) return
    if (reveal.anchor) {
      let id = reveal.anchor
      try {
        id = decodeURIComponent(id)
      } catch {
        /* keep */
      }
      const el = body.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) ?? body.querySelector<HTMLElement>(`[name="${CSS.escape(id)}"]`)
      if (el) {
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        scroller.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' })
        el.classList.add('mf-flash')
        setTimeout(() => el.classList.remove('mf-flash'), 1200)
        return
      }
    }
    if (reveal.line !== undefined) scrollPreviewToLine(reveal.line)
  }, [reveal, renderSeq, visible, tabId])

  /* ---------------------------------------------------------------- */
  /* Inline block editing                                              */
  /* ---------------------------------------------------------------- */

  const applySource = (id: string, next: string) => {
    if (editorBridge.currentTabId === id) editorBridge.setContent(id, next, 'input.blockedit')
    else updateContent(id, next)
  }

  const finishEdit = useCallback(
    (text: string | null) => {
      const ed = editingRef.current
      if (!ed) return
      editingRef.current = null
      ed.host.remove()
      ed.hidden.forEach((el) => el.style.removeProperty('display'))
      setEditing(null)
      if (text === null) return
      const current = getState().tabs.find((x) => x.id === ed.tabId)
      if (!current) return
      const source = editorBridge.getContent(ed.tabId) ?? current.content
      let next: string
      if (ed.append) {
        next = appendBlock(source, text)
      } else {
        if (text.replace(/\s+$/, '') === ed.original.replace(/\s+$/, '')) return
        const now = source.split('\n').slice(ed.range.start, ed.range.end).join('\n')
        if (now !== ed.original) {
          // The document changed underneath (e.g. reloaded from disk): don't guess.
          window.mf.copyText(text)
          toast(t('block.conflict'), 'error', 6000)
          return
        }
        next = replaceLines(source, ed.range, text)
      }
      if (next === source) return
      renderNow.current = true
      applySource(ed.tabId, next)
      // Keep "show source" toggles on the blocks below pointing at the same blocks.
      const toggles = sourceToggles.get(ed.tabId)
      if (toggles?.size && !ed.append) {
        const delta = next.split('\n').length - source.split('\n').length
        const shifted = [...toggles].map((s) => (s > ed.range.start ? s + delta : s))
        sourceToggles.set(ed.tabId, new Set(shifted))
      }
    },
    [t]
  )

  // Save / close / export commit the edit first; switching tab or mode does too.
  useEffect(() => {
    registerBlockEditFlush(editing ? () => finishEdit(editorText.current()) : null)
    return () => registerBlockEditFlush(null)
  }, [editing, finishEdit])

  useEffect(() => {
    const ed = editingRef.current
    if (ed && (ed.tabId !== tabId || !visible || viewMode !== 'preview')) finishEdit(editorText.current())
  }, [tabId, visible, viewMode, finishEdit])

  // Clicking anywhere outside the inline editor finishes the edit (keeping the changes).
  useEffect(() => {
    if (!editing) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (editing.host.contains(target)) return
      if ((target as Element).closest?.('.context-menu, .modal-backdrop')) return
      finishEdit(editorText.current())
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [editing, finishEdit])

  const startEdit = (start: number, hint?: { x: number; y: number }) => {
    const body = bodyRef.current
    const current = activeTab()
    if (!body || !current || current.kind !== 'markdown' || editingRef.current) return
    const source = editorBridge.getContent(current.id) ?? current.content
    const lines = source.split('\n')
    const range = blockRange(blocksRef.current, start, lines)
    const original = lines.slice(range.start, range.end).join('\n')
    const hidden = [...body.children].filter(
      (c) => c.getAttribute('data-block-start') === String(start) || c.getAttribute('data-source-of') === String(start)
    ) as HTMLElement[]
    if (!hidden.length) return
    const host = document.createElement('div')
    host.className = 'mf-block-editor-host'
    hidden[0].before(host)
    hidden.forEach((el) => (el.style.display = 'none'))
    const cursor = hint ? caretHint(original, hint.x, hint.y) : -1
    window.getSelection()?.removeAllRanges()
    setHover(null)
    setEditing({ tabId: current.id, range, original, cursor, append: false, host, hidden })
  }

  const startAppend = () => {
    const body = bodyRef.current
    const current = activeTab()
    if (!body || !current || current.kind !== 'markdown' || editingRef.current) return
    const host = document.createElement('div')
    host.className = 'mf-block-editor-host'
    body.appendChild(host)
    setHover(null)
    setEditing({ tabId: current.id, range: { start: 0, end: 0 }, original: '', cursor: -1, append: true, host, hidden: [] })
    requestAnimationFrame(() => host.scrollIntoView({ block: 'nearest' }))
  }

  /* ---------------------------------------------------------------- */
  /* Source view, zoom, copy                                           */
  /* ---------------------------------------------------------------- */

  const toggleSource = (start: number) => {
    if (!tabId) return
    const set = sourceToggles.get(tabId) ?? new Set<number>()
    if (set.has(start)) set.delete(start)
    else set.add(start)
    sourceToggles.set(tabId, set)
    setSourceSeq((n) => n + 1)
  }

  const blockSource = (start: number): string => {
    const current = activeTab()
    if (!current) return ''
    const lines = (editorBridge.getContent(current.id) ?? current.content).split('\n')
    const r = blockRange(blocksRef.current, start, lines)
    return lines.slice(r.start, r.end).join('\n')
  }

  const viewerName = (kind: string) => {
    const base = (activeTab()?.name ?? 'diagram').replace(/\.[^.]+$/, '')
    return `${basename(base)}-${kind}`
  }

  /** Open the zoom viewer for a diagram or image inside `el`. Returns false if there is none. */
  const zoomInto = (el: Element): boolean => {
    const diagram = el.closest('.mf-diagram') ?? el.querySelector('.mf-diagram')
    const svg = diagram?.querySelector('.mf-diagram-svg svg')
    if (svg) {
      setState({ viewer: { kind: 'svg', content: svg.outerHTML, name: viewerName(diagram!.getAttribute('data-kind') ?? 'diagram') } })
      return true
    }
    const img = (el.tagName === 'IMG' ? el : el.querySelector('img')) as HTMLImageElement | null
    if (img) {
      setState({ viewer: { kind: 'image', content: img.currentSrc || img.src, name: viewerName('image') } })
      return true
    }
    return false
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  // Track the heading at the top of the viewport for the outline.
  const onScroll = () => {
    onPreviewScroll()
    const scroller = scrollRef.current
    if (!scroller || !tabId) return
    scrollPositions.set(tabId, scroller.scrollTop)
    const base = scroller.getBoundingClientRect().top
    let current: string | null = null
    for (const el of headingEls.current) {
      if (el.getBoundingClientRect().top - base <= 80) current = el.id
      else break
    }
    if (!current && headingEls.current.length) current = headingEls.current[0].id
    if (getState().activeHeading !== current) setState({ activeHeading: current })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (editingRef.current) return
    const target = e.target as HTMLElement
    if (target.closest('.block-tools')) return
    const scroller = scrollRef.current
    const block = topBlockOf(target, bodyRef.current)
    if (!block || !scroller) {
      if (hover) setHover(null)
      return
    }
    const start = blockStartOf(block)
    if (hover?.start === start) return
    const sr = scroller.getBoundingClientRect()
    const br = block.getBoundingClientRect()
    setHover({
      start,
      top: br.top - sr.top + scroller.scrollTop,
      left: br.right - sr.left + scroller.scrollLeft,
      zoomable: !!block.querySelector('.mf-diagram-svg svg, .mf-diagram-svg img, img') || block.tagName === 'IMG'
    })
  }

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const tabNow = activeTab()
    if (!tabNow) return

    const exit = target.closest<HTMLElement>('[data-source-exit]')
    if (exit) {
      toggleSource(Number(exit.getAttribute('data-source-exit')))
      return
    }

    const box = target.closest<HTMLInputElement>('input.task-list-item-checkbox')
    if (box) {
      e.preventDefault()
      const line = Number(box.getAttribute('data-task-line'))
      const source = editorBridge.getContent(tabNow.id) ?? tabNow.content
      const next = toggleTaskInSource(source, line)
      if (next !== null) applySource(tabNow.id, next)
      return
    }

    const copy = target.closest<HTMLButtonElement>('.mf-copy-btn')
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code')?.textContent ?? ''
      window.mf.copyText(code.replace(/\n$/, ''))
      copy.textContent = t('preview.copied')
      copy.classList.add('done')
      setTimeout(() => {
        copy.textContent = t('preview.copy')
        copy.classList.remove('done')
      }, 1200)
      return
    }

    const link = target.closest<HTMLAnchorElement>('a')
    if (link) {
      e.preventDefault()
      const wiki = link.getAttribute('data-wikilink')
      if (wiki !== null) {
        void openWikilink(wiki)
        return
      }
      const href = link.getAttribute('href')
      if (href) void followLink(href).catch((err) => toast(String(err?.message ?? err), 'error'))
      return
    }

    // Diagrams and images open in the zoom viewer.
    const zoomTarget = target.closest('.mf-diagram-svg, img')
    if (zoomTarget) zoomInto(zoomTarget)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('a, input, button, .mf-diagram-svg, img, summary')) return
    if (getState().viewMode === 'split') {
      const el = target.closest<HTMLElement>('[data-line]')
      if (el) editorBridge.revealLine(Number(el.getAttribute('data-line')), { focus: true })
      return
    }
    if (getState().viewMode !== 'preview' || !getState().settings.dblclickToEdit) return
    const block = topBlockOf(target, bodyRef.current)
    if (block) startEdit(blockStartOf(block), { x: e.clientX, y: e.clientY })
  }

  const onContextMenu = (e: React.MouseEvent) => {
    const body = bodyRef.current
    const target = e.target as HTMLElement
    const tabNow = activeTab()
    if (!body || !tabNow || target.closest('.mf-block-editor-host, .block-tools')) return
    const copied = (text: string) => {
      window.mf.copyText(text)
      toast(t('toast.copied'), 'success', 1500)
    }
    const items: MenuItem[] = []

    const link = target.closest<HTMLAnchorElement>('a[href]:not(.mf-anchor)')
    if (link && body.contains(link)) {
      const wiki = link.getAttribute('data-wikilink')
      const href = link.getAttribute('href') ?? ''
      if (wiki !== null) items.push({ label: t('ctx.openPage', { name: wiki }), onClick: () => void openWikilink(wiki) })
      else
        items.push(
          { label: t('ctx.openLink'), onClick: () => void followLink(href).catch((err) => toast(String(err?.message ?? err), 'error')) },
          { label: t('ctx.copyLink'), onClick: () => copied(href) }
        )
      items.push({ separator: true })
    }

    const img = target.closest<HTMLImageElement>('img')
    const diagram = target.closest('.mf-diagram')
    if (diagram) items.push({ label: t('block.zoom'), onClick: () => zoomInto(diagram) }, { separator: true })
    else if (img) {
      const src = img.currentSrc || img.src
      const path = assetPath(src)
      items.push(
        { label: t('block.zoom'), onClick: () => zoomInto(img) },
        { label: t('ctx.copyImage'), onClick: () => void copyImage(src) },
        { label: t('ctx.copyImageAddress'), onClick: () => copied(path ?? img.getAttribute('src') ?? src) },
        ...(path ? [{ label: revealLabel(), onClick: () => window.mf.showItemInFolder(path) }] : []),
        { separator: true }
      )
    }

    const pre = target.closest('pre')
    const code = pre?.querySelector('code')
    if (code && !diagram) items.push({ label: t('ctx.copyCode'), onClick: () => copied((code.textContent ?? '').replace(/\n$/, '')) }, { separator: true })

    const heading = target.closest<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
    if (heading) items.push({ label: t('ctx.copyAnchor'), onClick: () => copied(`#${heading.id}`) }, { separator: true })

    const sel = window.getSelection()
    const hasSelection = !!sel && !sel.isCollapsed && !!sel.anchorNode && body.contains(sel.anchorNode)
    items.push(
      { label: t('menu.copy'), shortcut: clipboardKey('C'), disabled: !hasSelection, onClick: () => window.mf.editAction('copy') },
      {
        label: t('menu.selectAll'),
        shortcut: clipboardKey('A'),
        onClick: () => {
          const range = document.createRange()
          range.selectNodeContents(body)
          window.getSelection()?.removeAllRanges()
          window.getSelection()?.addRange(range)
        }
      }
    )

    const block = tabNow.kind === 'markdown' ? topBlockOf(target, body) : null
    if (block && !editingRef.current) {
      const start = blockStartOf(block)
      const mode = getState().viewMode
      const shown = !!sourceToggles.get(tabNow.id)?.has(start)
      items.push(
        { separator: true },
        mode === 'preview'
          ? { label: t('ctx.editBlock'), onClick: () => startEdit(start) }
          : { label: t('block.jump'), onClick: () => editorBridge.revealLine(start, { focus: true }) },
        { label: t(shown ? 'block.rendered' : 'block.source'), onClick: () => toggleSource(start) },
        { label: t('block.copy'), onClick: () => copied(blockSource(start)) }
      )
    }
    openContextMenu(e, items)
  }

  const width = useStore((s) => s.settings.previewWidth)
  const fontSize = useStore((s) => s.settings.previewFontSize)
  const fontFamily = useStore((s) => s.settings.previewFontFamily)
  const isEmpty = !!tabId && !content.trim()
  const canEdit = viewMode === 'preview' && !!tabId
  const showSource = hover ? !!tabId && !!sourceToggles.get(tabId)?.has(hover.start) : false

  return (
    <div
      className={`preview-scroll width-${width}${editing ? ' block-editing' : ''}`}
      ref={scrollRef}
      onScroll={onScroll}
      onPointerEnter={() => setDriver('preview')}
      onWheel={() => setDriver('preview')}
      onKeyDown={() => setDriver('preview')}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHover(null)}
      tabIndex={-1}
    >
      {isEmpty && viewMode === 'preview' && !editing && <div className="preview-empty">{t('preview.empty')}</div>}
      <article
        ref={bodyRef}
        className="markdown-body"
        style={{
          fontSize: `${fontSize}px`,
          fontFamily: fontFamily.trim() ? `${fontFamily}, var(--font-reading)` : undefined
        }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {canEdit && !editing && (
        <div className="preview-add-wrap">
          <button className="preview-add-block" onClick={startAppend}>
            <Plus size={15} /> {t('block.add')}
          </button>
        </div>
      )}
      {hover && !editing && tabId && (
        <div className="block-tools" style={{ top: hover.top, left: hover.left }}>
          {viewMode === 'preview' ? (
            <button title={t('block.edit')} onClick={() => startEdit(hover.start)}>
              <PenLine size={14} />
            </button>
          ) : (
            <button title={t('block.jump')} onClick={() => editorBridge.revealLine(hover.start, { focus: true })}>
              <Crosshair size={14} />
            </button>
          )}
          <button
            title={showSource ? t('block.rendered') : t('block.source')}
            className={showSource ? 'on' : ''}
            onClick={() => toggleSource(hover.start)}
          >
            {showSource ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          {hover.zoomable && (
            <button
              title={t('block.zoom')}
              onClick={() => {
                const el = [...(bodyRef.current?.children ?? [])].find(
                  (c) => c.getAttribute('data-block-start') === String(hover.start)
                )
                if (el) zoomInto(el)
              }}
            >
              <Maximize2 size={14} />
            </button>
          )}
          <button
            title={t('block.copy')}
            onClick={() => {
              window.mf.copyText(blockSource(hover.start))
              toast(t('block.copied'), 'success', 1500)
            }}
          >
            <Copy size={14} />
          </button>
        </div>
      )}
      {editing &&
        createPortal(
          <BlockEditor
            key={`${editing.tabId}:${editing.range.start}:${editing.append}`}
            initial={editing.original}
            cursor={editing.cursor}
            onDone={finishEdit}
            textRef={editorText}
          />,
          editing.host
        )}
    </div>
  )
}
