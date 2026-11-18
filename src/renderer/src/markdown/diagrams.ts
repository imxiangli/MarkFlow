/**
 * Lazy-loaded diagram renderers. Every renderer returns an HTML string (usually inline SVG)
 * so results can be cached and diffed by morphdom without flicker.
 */
import DOMPurify from 'dompurify'
import { hashString } from '@/lib/hash'
import { load as loadYaml } from 'js-yaml'

export type DiagramKind = 'mermaid' | 'graphviz' | 'plantuml' | 'echarts'

export interface DiagramContext {
  theme: 'light' | 'dark'
  plantumlEnabled: boolean
  plantumlServer: string
  width: number
  messages: { error: string; plantumlDisabled: string }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function errorBox(title: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `<div class="mf-diagram-error"><strong>${escapeHtml(title)}</strong><pre>${escapeHtml(msg)}</pre></div>`
}

function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true }
  } as Parameters<typeof DOMPurify.sanitize>[1]) as unknown as string
}

/* ---------------- mermaid ---------------- */

type Mermaid = (typeof import('mermaid'))['default']
let mermaidPromise: Promise<Mermaid> | null = null
let mermaidTheme: string | null = null
let mermaidSeq = 0
let mermaidQueue: Promise<unknown> = Promise.resolve()

async function renderMermaid(code: string, ctx: DiagramContext): Promise<string> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidPromise
  // mermaid.render is not re-entrant: serialise calls.
  const job = mermaidQueue.then(async () => {
    if (mermaidTheme !== ctx.theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: ctx.theme === 'dark' ? 'dark' : 'default'
      })
      mermaidTheme = ctx.theme
    }
    const id = `mf-mermaid-${++mermaidSeq}`
    try {
      const { svg } = await mermaid.render(id, code)
      return `<div class="mf-diagram-svg">${svg}</div>`
    } catch (err) {
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
      return errorBox(`Mermaid · ${ctx.messages.error}`, err)
    }
  })
  mermaidQueue = job.catch(() => undefined)
  return job
}

/* ---------------- graphviz ---------------- */

type Viz = Awaited<ReturnType<(typeof import('@viz-js/viz'))['instance']>>
let vizPromise: Promise<Viz> | null = null

async function renderGraphviz(code: string, ctx: DiagramContext): Promise<string> {
  vizPromise ??= import('@viz-js/viz').then((m) => m.instance())
  try {
    const viz = await vizPromise
    const svg = viz.renderString(code, { format: 'svg', engine: 'dot' })
    return `<div class="mf-diagram-svg">${sanitizeSvg(svg)}</div>`
  } catch (err) {
    return errorBox(`Graphviz · ${ctx.messages.error}`, err)
  }
}

/* ---------------- echarts ---------------- */

async function parseOption(code: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(code)
  } catch {
    // YAML is a superset of JSON and accepts most hand-written JS object literals.
    const v = loadYaml(code)
    if (!v || typeof v !== 'object') throw new Error('ECharts option must be a JSON / YAML object')
    return v as Record<string, unknown>
  }
}

async function renderECharts(code: string, ctx: DiagramContext): Promise<string> {
  try {
    const [echarts, option] = await Promise.all([import('echarts'), parseOption(code)])
    const width = Math.max(320, Math.min(1200, ctx.width || 720))
    const height = typeof option.height === 'number' ? option.height : Math.round(Math.min(480, width * 0.6))
    const chart = echarts.init(null, ctx.theme === 'dark' ? 'dark' : undefined, {
      renderer: 'svg',
      ssr: true,
      width,
      height
    })
    chart.setOption({ backgroundColor: 'transparent', animation: false, ...option })
    const svg = chart.renderToSVGString()
    chart.dispose()
    return `<div class="mf-diagram-svg mf-echarts">${sanitizeSvg(svg)}</div>`
  } catch (err) {
    return errorBox(`ECharts · ${ctx.messages.error}`, err)
  }
}

/* ---------------- plantuml ---------------- */

function encode6bit(b: number): string {
  if (b < 10) return String.fromCharCode(48 + b)
  b -= 10
  if (b < 26) return String.fromCharCode(65 + b)
  b -= 26
  if (b < 26) return String.fromCharCode(97 + b)
  b -= 26
  if (b === 0) return '-'
  if (b === 1) return '_'
  return '?'
}

function append3bytes(b1: number, b2: number, b3: number): string {
  const c1 = b1 >> 2
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4)
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6)
  const c4 = b3 & 0x3f
  return encode6bit(c1 & 0x3f) + encode6bit(c2 & 0x3f) + encode6bit(c3 & 0x3f) + encode6bit(c4 & 0x3f)
}

function plantumlEncode(data: Uint8Array): string {
  let r = ''
  for (let i = 0; i < data.length; i += 3) {
    if (i + 2 === data.length) r += append3bytes(data[i], data[i + 1], 0)
    else if (i + 1 === data.length) r += append3bytes(data[i], 0, 0)
    else r += append3bytes(data[i], data[i + 1], data[i + 2])
  }
  return r
}

async function renderPlantUML(code: string, ctx: DiagramContext): Promise<string> {
  if (!ctx.plantumlEnabled) {
    return `<div class="mf-diagram-note">${escapeHtml(ctx.messages.plantumlDisabled)}</div><pre class="mf-code"><code>${escapeHtml(code)}</code></pre>`
  }
  try {
    const stream = new Blob([new TextEncoder().encode(code)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    const server = ctx.plantumlServer.replace(/\/+$/, '')
    const url = `${server}/svg/${plantumlEncode(bytes)}`
    return `<div class="mf-diagram-svg mf-plantuml"><img src="${escapeHtml(url)}" alt="PlantUML diagram"></div>`
  } catch (err) {
    return errorBox(`PlantUML · ${ctx.messages.error}`, err)
  }
}

/* ---------------- public API ---------------- */

const cache = new Map<string, string>()
const MAX_CACHE = 300


export function diagramKey(kind: DiagramKind, code: string, ctx: DiagramContext): string {
  const extra = kind === 'plantuml' ? `${ctx.plantumlEnabled}|${ctx.plantumlServer}` : kind === 'echarts' ? String(Math.round(ctx.width / 80)) : ''
  return hashString(`${kind}\u0000${ctx.theme}\u0000${extra}\u0000${code}`)
}

export function getCachedDiagram(key: string): string | undefined {
  return cache.get(key)
}

const inflight = new Map<string, Promise<string>>()

export function renderDiagram(kind: DiagramKind, code: string, ctx: DiagramContext, key: string): Promise<string> {
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(key)
  if (p) return p
  const run =
    kind === 'mermaid'
      ? renderMermaid
      : kind === 'graphviz'
        ? renderGraphviz
        : kind === 'echarts'
          ? renderECharts
          : renderPlantUML
  p = run(code, ctx).then((html) => {
    inflight.delete(key)
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!)
    cache.set(key, html)
    return html
  })
  inflight.set(key, p)
  return p
}
