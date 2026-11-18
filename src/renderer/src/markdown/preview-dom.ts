import DOMPurify from 'dompurify'
import morphdom from 'morphdom'
import hljs from 'highlight.js'
import { toAssetUrl } from '@shared/constants'
import { dirname, fileUrlToPath, isAbsolute, join } from '@/lib/path'
import { diagramKey, getCachedDiagram, renderDiagram, type DiagramContext, type DiagramKind } from './diagrams'

// data: URIs are not listed: DOMPurify still allows them on media tags (img, video, audio, source).
const URI_RE =
  /^(?:(?:https?|mailto|tel|ftp|file|mf-asset|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ['iframe', 'semantics', 'annotation'],
  ADD_ATTR: ['target', 'allow', 'allowfullscreen', 'frameborder', 'scrolling', 'loading', 'controls', 'encoding'],
  FORBID_TAGS: ['style', 'script', 'base', 'meta', 'link', 'form'],
  ALLOWED_URI_REGEXP: URI_RE,
  RETURN_DOM_FRAGMENT: true
}

let hooksInstalled = false
function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src') ?? ''
      if (!/^https?:/i.test(src)) el.remove()
      else el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation')
    }
    if (el.tagName === 'A' && el.getAttribute('target')) el.removeAttribute('target')
  })
}

export function sanitizeToFragment(html: string): DocumentFragment {
  installHooks()
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as DocumentFragment
}

const REMOTE_RE = /^(?:https?|data|blob|mf-asset):/i

/** Resolve a URL found in a document to an absolute local path, or null if it is remote. */
export function resolveLocalPath(raw: string, baseDir: string | null): string | null {
  const v = raw.trim()
  if (!v || v.startsWith('#') || REMOTE_RE.test(v) || /^(mailto|tel|ftp|javascript):/i.test(v)) return null
  if (/^file:/i.test(v)) {
    try {
      return fileUrlToPath(v)
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[a-zA-Z]:[\\/]/.test(v)) return null
  let p = v.replace(/[?#].*$/, '')
  try {
    p = decodeURI(p)
  } catch {
    // keep raw
  }
  if (isAbsolute(p)) return p
  if (p.startsWith('~/')) return null
  return baseDir ? join(baseDir, p) : null
}

export interface SourceBlock {
  start: number
  source: string
}

export interface DecorateOptions {
  filePath: string | null
  root: string | null
  copyLabel: string
  diagram: DiagramContext
  /** Top-level blocks to show as Markdown source instead of rendered. */
  sourceBlocks?: SourceBlock[]
  sourceLabels?: { title: string; exit: string }
}

function decorate(frag: DocumentFragment, opts: DecorateOptions): void {
  const baseDir = opts.filePath ? dirname(opts.filePath) : opts.root

  for (const el of frag.querySelectorAll<HTMLElement>('img[src], video[src], audio[src], source[src], video[poster]')) {
    for (const attr of ['src', 'poster']) {
      const v = el.getAttribute(attr)
      if (!v) continue
      const abs = resolveLocalPath(v, baseDir)
      if (abs) {
        el.setAttribute(attr, toAssetUrl(abs))
        el.setAttribute(`data-mf-${attr}`, abs)
        el.setAttribute(`data-mf-orig-${attr}`, v)
      }
    }
  }

  for (const pre of frag.querySelectorAll<HTMLElement>('pre.mf-code')) {
    const tools = document.createElement('div')
    tools.className = 'mf-code-tools'
    const lang = pre.getAttribute('data-lang')
    if (lang) {
      const span = document.createElement('span')
      span.className = 'mf-code-lang'
      span.textContent = lang
      tools.appendChild(span)
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mf-copy-btn'
    btn.textContent = opts.copyLabel
    tools.appendChild(btn)
    pre.insertBefore(tools, pre.firstChild)
  }

  // Blocks the user switched to "show source": keep the rendered element (hidden, so print and
  // export still use it) and add a highlighted Markdown view right after it.
  for (const sb of opts.sourceBlocks ?? []) {
    const el = [...frag.children].find((c) => c.getAttribute('data-block-start') === String(sb.start))
    if (!el) continue
    el.setAttribute('data-source-hidden', '')
    const view = document.createElement('div')
    view.className = 'mf-block-source'
    view.setAttribute('data-source-of', String(sb.start))
    view.setAttribute('data-line', String(sb.start))
    const head = document.createElement('div')
    head.className = 'mf-block-source-head'
    const label = document.createElement('span')
    label.textContent = opts.sourceLabels?.title ?? 'Markdown'
    const exit = document.createElement('button')
    exit.type = 'button'
    exit.className = 'mf-block-source-exit'
    exit.setAttribute('data-source-exit', String(sb.start))
    exit.textContent = opts.sourceLabels?.exit ?? 'Rendered'
    head.append(label, exit)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.className = 'hljs language-markdown'
    code.innerHTML = hljs.highlight(sb.source, { language: 'markdown', ignoreIllegals: true }).value
    pre.appendChild(code)
    view.append(head, pre)
    el.after(view)
  }

  for (const el of frag.querySelectorAll<HTMLElement>('.mf-diagram')) {
    const kind = el.getAttribute('data-kind') as DiagramKind
    const code = el.querySelector('.mf-diagram-source')?.textContent ?? ''
    const key = diagramKey(kind, code, opts.diagram)
    el.setAttribute('data-key', key)
    pendingSources.set(key, { kind, code })
    const cached = getCachedDiagram(key)
    if (cached !== undefined) {
      el.innerHTML = cached
      el.setAttribute('data-state', 'done')
    } else {
      el.setAttribute('data-state', 'pending')
    }
  }
}

const pendingSources = new Map<string, { kind: DiagramKind; code: string }>()

/** Patch `container` so it shows `html`, reusing DOM nodes that did not change. */
export function patchPreview(container: HTMLElement, html: string, opts: DecorateOptions): void {
  const frag = sanitizeToFragment(html)
  decorate(frag, opts)
  const next = container.cloneNode(false) as HTMLElement
  next.appendChild(frag)
  morphdom(container, next, {
    childrenOnly: true,
    onBeforeElUpdated(from, to) {
      if (from.isEqualNode(to)) return false
      // Keep showing the previous diagram while the edited version renders.
      if (
        from.classList.contains('mf-diagram') &&
        to.getAttribute('data-state') === 'pending' &&
        from.getAttribute('data-state') !== 'pending' &&
        from.getAttribute('data-kind') === to.getAttribute('data-kind')
      ) {
        from.setAttribute('data-key', to.getAttribute('data-key') ?? '')
        from.setAttribute('data-state', 'pending')
        from.setAttribute('data-line', to.getAttribute('data-line') ?? '')
        from.classList.add('mf-stale')
        return false
      }
      // Preserve the open/closed state the user chose for <details>.
      if (from.tagName === 'DETAILS' && to.tagName === 'DETAILS') {
        if ((from as HTMLDetailsElement).dataset.userToggled) {
          ;(to as HTMLDetailsElement).open = (from as HTMLDetailsElement).open
          to.setAttribute('data-user-toggled', '1')
        }
      }
      return true
    }
  })
}

/** Render diagrams that are still pending inside `container`. Resolves when all are done. */
export async function renderPendingDiagrams(container: HTMLElement, ctx: DiagramContext): Promise<boolean> {
  const pending = [...container.querySelectorAll<HTMLElement>('.mf-diagram[data-state="pending"]')]
  if (!pending.length) return false
  const keys = [...new Set(pending.map((el) => el.getAttribute('data-key') ?? ''))]
  await Promise.all(
    keys.map(async (key) => {
      const src = pendingSources.get(key)
      if (!src) return
      const html = await renderDiagram(src.kind, src.code, ctx, key)
      for (const el of container.querySelectorAll<HTMLElement>(`.mf-diagram[data-key="${key}"]`)) {
        el.innerHTML = html
        el.setAttribute('data-state', 'done')
        el.classList.remove('mf-stale')
      }
    })
  )
  if (pendingSources.size > 500) pendingSources.clear()
  return true
}
