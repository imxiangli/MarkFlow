/**
 * Markdown → HTML pipeline (pure: no DOM access, so it can be unit tested in Node).
 *
 * Supported syntax:
 *  - CommonMark + GFM (tables, strikethrough, task lists, autolinks, footnotes, alerts)
 *  - Math (KaTeX, incl. mhchem) via $…$, $$…$$ and ```math fences
 *  - Diagrams: mermaid, graphviz (dot), echarts, plantuml (placeholders, rendered later)
 *  - Emoji shortcodes, sub/superscript, ==mark==, ++insert++, abbreviations,
 *    definition lists, custom containers (::: tip), attributes {.class #id},
 *    heading anchors, [TOC], YAML front matter, [[wikilinks]] and ![[embeds]]
 */
import MarkdownItCtor, { type MarkdownIt, type StateCore, type StateInline, type Token } from 'markdown-it'
import hljs from 'highlight.js'
import katex from 'katex'
import 'katex/contrib/mhchem'
import { load as loadYaml } from 'js-yaml'
import markdownItKatexModule from '@vscode/markdown-it-katex'
import { full as emoji } from 'markdown-it-emoji'
import footnote from 'markdown-it-footnote'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import mark from 'markdown-it-mark'
import ins from 'markdown-it-ins'
import abbr from 'markdown-it-abbr'
import deflist from 'markdown-it-deflist'
import container from 'markdown-it-container'
import attrsModule from 'markdown-it-attrs'
import anchor from 'markdown-it-anchor'
import alerts from 'markdown-it-github-alerts'
import frontMatterModule from 'markdown-it-front-matter'

/** CJS plugins compiled from TypeScript expose `.default`; normalise for every bundler/runtime. */
function interop<T>(mod: T): T {
  return ((mod as { default?: T })?.default ?? mod) as T
}
const markdownItKatex = interop(markdownItKatexModule)
const attrs = interop(attrsModule)
const frontMatter = interop(frontMatterModule)

export type MdLocale = 'zh-CN' | 'en'

export interface Heading {
  level: number
  text: string
  id: string
  line: number
}

export interface MarkdownResult {
  html: string
  headings: Heading[]
  /** Sorted 0-based start lines of the top-level blocks (see blockRange in lib/blocks). */
  blocks: number[]
}

interface Env {
  headings?: Heading[]
  [key: string | symbol]: unknown
}

export const DIAGRAM_LANGS: Record<string, 'mermaid' | 'graphviz' | 'plantuml' | 'echarts'> = {
  mermaid: 'mermaid',
  dot: 'graphviz',
  graphviz: 'graphviz',
  viz: 'graphviz',
  plantuml: 'plantuml',
  puml: 'plantuml',
  uml: 'plantuml',
  echarts: 'echarts'
}

const MATH_LANGS = new Set(['math', 'latex', 'katex', 'tex'])

const LABELS: Record<MdLocale, Record<string, string>> = {
  'zh-CN': {
    tip: '提示',
    info: '信息',
    note: '注意',
    warning: '警告',
    danger: '危险',
    caution: '小心',
    important: '重要',
    success: '成功',
    details: '详情',
    frontMatter: '文档属性',
    toc: '目录'
  },
  en: {
    tip: 'Tip',
    info: 'Info',
    note: 'Note',
    warning: 'Warning',
    danger: 'Danger',
    caution: 'Caution',
    important: 'Important',
    success: 'Success',
    details: 'Details',
    frontMatter: 'Properties',
    toc: 'Contents'
  }
}

const CONTAINERS = ['tip', 'info', 'note', 'warning', 'danger', 'caution', 'important', 'success', 'details']

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\p{M}_-]/gu, '')
}

const KATEX_OPTIONS = { throwOnError: false, strict: 'ignore' as const, output: 'htmlAndMathml' as const }

function renderMath(src: string, displayMode: boolean): string {
  try {
    return katex.renderToString(src, { ...KATEX_OPTIONS, displayMode })
  } catch (err) {
    return `<span class="mf-error">${escapeHtml(String((err as Error).message))}</span>`
  }
}

/* ---------------------------------------------------------------- */
/* Plugins                                                           */
/* ---------------------------------------------------------------- */

/** data-line (scroll sync) plus data-block-start on top-level blocks (block editing). */
function blockAttrs(t: Token): string {
  if (!t.map) return ''
  return ` data-line="${t.map[0]}"${t.level === 0 ? ` data-block-start="${t.map[0]}"` : ''}`
}

/** Adds data-line="N" (0-based source line) to block tokens, used for scroll sync. */
function sourceLines(md: MarkdownIt): void {
  md.core.ruler.push('mf_source_line', (state: StateCore) => {
    for (const t of state.tokens) {
      if (t.map && t.block && t.nesting !== -1) {
        t.attrSet('data-line', String(t.map[0]))
        if (t.level === 0) t.attrSet('data-block-start', String(t.map[0]))
      }
    }
  })
}

/** GFM task lists with source line info so checkboxes can be toggled from the preview. */
function taskLists(md: MarkdownIt): void {
  md.core.ruler.after('text_join', 'mf_task_lists', (state: StateCore) => {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') {
        continue
      }
      const m = /^\[([ xX])\](?=\s|$)/.exec(tok.content)
      const first = tok.children?.[0]
      if (!m || !first || first.type !== 'text' || !/^\[([ xX])\]/.test(first.content)) continue
      const checked = m[1] !== ' '
      first.content = first.content.slice(3).replace(/^[ \t]/, '')
      const item = tokens[i - 2]
      const line = item.map?.[0] ?? tok.map?.[0] ?? 0
      const box = new state.Token('html_inline', '', 0)
      box.content = `<input type="checkbox" class="task-list-item-checkbox" data-task-line="${line}"${checked ? ' checked' : ''}>`
      tok.children!.unshift(box)
      item.attrJoin('class', 'task-list-item')
      for (let j = i - 3; j >= 0; j--) {
        const t = tokens[j]
        if (t.level === item.level - 1 && (t.type === 'bullet_list_open' || t.type === 'ordered_list_open')) {
          if (!String(t.attrGet('class') ?? '').includes('contains-task-list')) t.attrJoin('class', 'contains-task-list')
          break
        }
      }
    }
  })
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|apng)$/i

/** [[Page]], [[Page|Alias]], [[Page#Heading]] and ![[image.png]] (Obsidian-style). */
function wikilinks(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'mf_wikilink', (state: StateInline, silent: boolean) => {
    const src = state.src
    let pos = state.pos
    const embed = src.charCodeAt(pos) === 0x21
    if (embed) pos++
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false
    const end = src.indexOf(']]', pos + 2)
    if (end < 0) return false
    const inner = src.slice(pos + 2, end)
    if (!inner.trim() || /[[\]\n]/.test(inner)) return false
    if (!silent) {
      const bar = inner.indexOf('|')
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
      const alias = (bar >= 0 ? inner.slice(bar + 1) : '').trim()
      const token = state.push('html_inline', '', 0)
      if (embed && IMAGE_RE.test(target)) {
        const size = /^\d+(x\d+)?$/.test(alias) ? alias.split('x') : null
        const sizeAttr = size ? ` width="${size[0]}"${size[1] ? ` height="${size[1]}"` : ''}` : ''
        token.content = `<img src="${escapeHtml(encodeURI(target))}" alt="${escapeHtml(size ? target : alias || target)}"${sizeAttr} class="mf-embed">`
      } else {
        const label = alias || target
        token.content = `<a href="#" class="mf-wikilink" data-wikilink="${escapeHtml(target)}">${escapeHtml(label)}</a>`
      }
    }
    state.pos = end + 2
    return true
  })
}

function headingText(tokens: Token[] | null): string {
  if (!tokens) return ''
  let out = ''
  let skip = 0
  for (const t of tokens) {
    if (t.type === 'link_open' && String(t.attrGet('class') ?? '').includes('mf-anchor')) {
      skip++
      continue
    }
    if (skip) {
      if (t.type === 'link_close') skip--
      continue
    }
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'math_inline') out += t.content
    else if (t.type === 'image') out += t.content
    else if (t.type === 'html_inline') {
      const m = /data-wikilink="([^"]*)"[^>]*>([^<]*)</.exec(t.content)
      if (m) out += m[2]
    } else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' '
  }
  return out.trim()
}

function collectHeadings(tokens: Token[]): Heading[] {
  const out: Heading[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'heading_open') continue
    out.push({
      level: Number(t.tag.slice(1)),
      id: String(t.attrGet('id') ?? ''),
      text: headingText(tokens[i + 1]?.children ?? null),
      line: t.map?.[0] ?? 0
    })
  }
  return out
}

function buildToc(headings: Heading[], title: string): string {
  if (!headings.length) return ''
  const min = Math.min(...headings.map((h) => h.level))
  let html = `<nav class="mf-toc"><p class="mf-toc-title">${escapeHtml(title)}</p>`
  let depth = 0
  for (const h of headings) {
    const level = h.level - min + 1
    if (level > depth) {
      while (depth < level) {
        html += '<ul>'
        depth++
      }
    } else {
      html += '</li>'
      while (depth > level) {
        html += '</ul></li>'
        depth--
      }
    }
    html += `<li><a href="#${escapeHtml(encodeURIComponent(h.id))}">${escapeHtml(h.text)}</a>`
  }
  html += '</li>'
  while (depth > 1) {
    html += '</ul></li>'
    depth--
  }
  return html + '</ul></nav>'
}

const TOC_RE = /^\s*(\[toc\]|\[\[toc\]\]|\$\{toc\}|\[\[_toc_\]\])\s*$/i

function toc(md: MarkdownIt, title: string): void {
  md.core.ruler.push('mf_toc', (state: StateCore) => {
    const tokens = state.tokens
    const headings = collectHeadings(tokens)
    ;(state.env as Env).headings = headings
    for (let i = 0; i < tokens.length - 2; i++) {
      if (
        tokens[i].type === 'paragraph_open' &&
        tokens[i + 1].type === 'inline' &&
        tokens[i + 2].type === 'paragraph_close' &&
        TOC_RE.test(tokens[i + 1].content)
      ) {
        const t = new state.Token('html_block', '', 0)
        t.map = tokens[i].map
        t.content = buildToc(headings, title).replace('<nav class="mf-toc"', `<nav class="mf-toc"${blockAttrs(tokens[i])}`)
        t.block = true
        tokens.splice(i, 3, t)
      }
    }
  })
}

function renderFrontMatter(raw: string, title: string): string {
  let data: unknown
  try {
    data = loadYaml(raw)
  } catch {
    data = null
  }
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    if (Array.isArray(v)) return v.map((x) => `<span class="mf-fm-tag">${escapeHtml(typeof x === 'object' ? JSON.stringify(x) : String(x))}</span>`).join(' ')
    if (v instanceof Date) return escapeHtml(v.toISOString().slice(0, 10))
    if (typeof v === 'object') return `<code>${escapeHtml(JSON.stringify(v))}</code>`
    return escapeHtml(String(v))
  }
  let body: string
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const rows = Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${fmt(v)}</td></tr>`)
      .join('')
    body = `<table>${rows}</table>`
  } else {
    body = `<pre><code>${escapeHtml(raw)}</code></pre>`
  }
  return `<details class="mf-frontmatter" data-line="0" data-block-start="0" open><summary>${escapeHtml(title)}</summary>${body}</details>\n`
}


const ATTR_ITEM = String.raw`(?:[.#][^\s{}]+|[\w:-]+=(?:"[^"]*"|'[^']*'|[^\s{}]*))`
const ATTRS_LIKE = new RegExp(String.raw`^\s*${ATTR_ITEM}(?:\s+${ATTR_ITEM})*\s*$`)
const LB = '\uE000'
const RB = '\uE001'

/**
 * markdown-it-attrs treats any trailing `{word}` as an attribute list and silently drops it.
 * Only let through brace groups that clearly are attributes ({.cls}, {#id}, {key=value}).
 */
function attrsGuard(md: MarkdownIt): void {
  md.core.ruler.before('curly_attributes', 'mf_attrs_guard', (state: StateCore) => {
    for (const t of state.tokens) {
      if (t.type !== 'inline' || !t.children) continue
      for (const c of t.children) {
        if (c.type !== 'text' || !c.content.includes('{')) continue
        c.content = c.content.replace(/\{([^{}]*)\}/g, (all: string, inner: string) =>
          ATTRS_LIKE.test(inner) ? all : LB + inner + RB
        )
      }
    }
  })
  md.core.ruler.after('curly_attributes', 'mf_attrs_restore', (state: StateCore) => {
    for (const t of state.tokens) {
      if (t.type !== 'inline' || !t.children) continue
      for (const c of t.children) {
        if (c.type === 'text' && (c.content.includes(LB) || c.content.includes(RB))) {
          c.content = c.content.split(LB).join('{').split(RB).join('}')
        }
      }
    }
  })
}

/* ---------------------------------------------------------------- */
/* Factory                                                           */
/* ---------------------------------------------------------------- */

const BAD_PROTO_RE = /^(vbscript|javascript|data):/i
const IMAGE_DATA_RE = /^data:image\/[a-z0-9.+-]+[;,]/i

/**
 * markdown-it's default only allows data:image/(gif|png|jpeg|webp) and blocks file: URLs.
 * Local documents commonly use SVG data URIs and file:// paths; the output is sanitised by
 * DOMPurify afterwards, so only script-capable schemes and non-image data URIs are rejected.
 */
export function validateLink(url: string): boolean {
  const str = url.trim()
  return BAD_PROTO_RE.test(str) ? IMAGE_DATA_RE.test(str) : true
}

function createMarkdown(locale: MdLocale): MarkdownIt {
  const labels = LABELS[locale]
  const md = new MarkdownItCtor({ html: true, linkify: true, typographer: false, breaks: false })
  md.validateLink = validateLink

  md.use(frontMatter, () => undefined)
  md.renderer.rules.front_matter = (tokens, idx) => renderFrontMatter(String(tokens[idx].meta ?? ''), labels.frontMatter)

  md.use(markdownItKatex, { ...KATEX_OPTIONS, katex, enableFencedBlocks: false })
  md.renderer.rules.math_block = (tokens, idx) => {
    const t = tokens[idx]
    const line = blockAttrs(t)
    return `<div class="mf-math-block"${line}>${renderMath(t.content, true)}</div>\n`
  }

  md.use(emoji)
  md.use(footnote)
  md.use(sub)
  md.use(sup)
  md.use(mark)
  md.use(ins)
  md.use(abbr)
  md.use(deflist)
  md.use(alerts, {
    titles: { tip: labels.tip, note: labels.note, important: labels.important, warning: labels.warning, caution: labels.caution }
  })

  const alertOpen = md.renderer.rules.alert_open!
  md.renderer.rules.alert_open = (tokens, idx, options, env, slf) =>
    alertOpen(tokens, idx, options, env, slf).replace(/^<div/, `<div${blockAttrs(tokens[idx])}`)

  for (const name of CONTAINERS) {
    md.use(container, name, {
      render(tokens: Token[], idx: number) {
        const tok = tokens[idx]
        if (tok.nesting === 1) {
          const title = tok.info.trim().slice(name.length).trim() || labels[name]
          const line = blockAttrs(tok)
          if (name === 'details') {
            return `<details class="mf-container mf-container-details"${line}><summary>${md.renderInline(title)}</summary>\n`
          }
          return `<div class="mf-container mf-container-${name}"${line}><p class="mf-container-title">${md.renderInline(title)}</p>\n`
        }
        return name === 'details' ? '</details>\n' : '</div>\n'
      }
    })
  }

  md.use(wikilinks)
  md.use(taskLists)
  md.use(attrs, {
    allowedAttributes: ['id', 'class', 'style', 'width', 'height', 'align', 'title', 'target', 'rel', 'start', /^data-/]
  })
  md.use(attrsGuard)
  md.use(anchor, {
    slugify,
    uniqueSlugStartIndex: 1,
    tabIndex: false,
    permalink: anchor.permalink.linkInsideHeader({
      symbol: '#',
      placement: 'before',
      class: 'mf-anchor',
      ariaHidden: true
    })
  })
  md.use(toc, labels.toc)
  md.use(sourceLines)

  md.renderer.rules.fence = (tokens, idx, _options, _env, slf) => {
    const token = tokens[idx]
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
    const lang = (info.split(/\s+/)[0] ?? '').toLowerCase()
    const code = token.content
    const lineAttr = blockAttrs(token)

    if (MATH_LANGS.has(lang)) return `<div class="mf-math-block"${lineAttr}>${renderMath(code, true)}</div>\n`

    const diagram = DIAGRAM_LANGS[lang]
    if (diagram) {
      return `<div class="mf-diagram mf-diagram-${diagram}" data-kind="${diagram}"${lineAttr}><pre class="mf-diagram-source">${escapeHtml(code)}</pre></div>\n`
    }

    let highlighted = ''
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        highlighted = ''
      }
    }
    if (!highlighted) highlighted = escapeHtml(code)
    token.attrJoin('class', 'mf-code')
    if (lang) token.attrSet('data-lang', lang)
    return `<pre${slf.renderAttrs(token)}><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre>\n`
  }

  // Indented code blocks get the same look as fences.
  md.renderer.rules.code_block = (tokens, idx, _options, _env, slf) => {
    const token = tokens[idx]
    token.attrJoin('class', 'mf-code')
    return `<pre${slf.renderAttrs(token)}><code class="hljs">${escapeHtml(token.content)}</code></pre>\n`
  }

  // Tables scroll horizontally instead of overflowing the page.
  md.renderer.rules.table_open = (tokens, idx, options, _env, slf) => {
    const t = tokens[idx]
    const wrapAttrs = blockAttrs(t)
    if (t.attrs) t.attrs = t.attrs.filter(([name]) => name !== 'data-block-start')
    return `<div class="mf-table-wrap"${wrapAttrs}>${slf.renderToken(tokens, idx, options)}`
  }
  md.renderer.rules.table_close = (tokens, idx, options, _env, slf) => `${slf.renderToken(tokens, idx, options)}</div>`

  return md
}

const instances = new Map<MdLocale, MarkdownIt>()

export function getMarkdown(locale: MdLocale): MarkdownIt {
  let md = instances.get(locale)
  if (!md) {
    md = createMarkdown(locale)
    instances.set(locale, md)
  }
  return md
}

export function renderMarkdown(src: string, locale: MdLocale = 'zh-CN'): MarkdownResult {
  const md = getMarkdown(locale)
  const env: Env = {}
  const tokens = md.parse(src, env)
  const html = md.renderer.render(tokens, md.options, env)
  const blocks = [
    ...new Set(tokens.filter((t) => t.level === 0 && t.block && t.nesting !== -1 && t.map).map((t) => t.map![0]))
  ].sort((a, b) => a - b)
  return { html, headings: env.headings ?? collectHeadings(tokens), blocks }
}
