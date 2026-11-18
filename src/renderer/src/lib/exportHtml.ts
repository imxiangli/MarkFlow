import tokensCss from '@/styles/tokens.css?raw'
import markdownCss from '@/styles/markdown.css?raw'
import { relative } from '@/lib/path'
import { hljsThemes } from './theme'

const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg)))
    .join('/')
}

/** Turn the token rules that target [data-theme="dark"] into a prefers-color-scheme block. */
function themeCss(): string {
  const light = tokensCss.replace(/:root\[data-theme='dark'\][^{]*\{[^}]*\}/g, '')
  const darkBlock = /:root\[data-theme='dark'\][^{]*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? ''
  return `${light}\n@media (prefers-color-scheme: dark) { :root { ${darkBlock} } }`
}

function scopeHljsDark(css: string): string {
  return `@media (prefers-color-scheme: dark) { ${css} }`
}

/** Serialise the rendered preview into a self-contained HTML document. */
export function buildStandaloneHtml(title: string, outDir: string): string {
  const source = document.querySelector('.markdown-body')
  if (!source) throw new Error('Preview is not available')
  const clone = source.cloneNode(true) as HTMLElement
  clone.removeAttribute('style')
  clone.querySelectorAll('.mf-code-tools').forEach((el) => el.remove())
  clone.querySelectorAll('.mf-diagram-source, .mf-block-source, .mf-block-editor-host').forEach((el) => el.remove())
  clone.querySelectorAll('[data-source-hidden]').forEach((el) => el.removeAttribute('data-source-hidden'))
  clone.querySelectorAll<HTMLElement>('[data-block-start]').forEach((el) => {
    el.removeAttribute('data-block-start')
    el.style.removeProperty('display')
  })
  clone.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox').forEach((el) => el.setAttribute('disabled', ''))
  for (const el of clone.querySelectorAll<HTMLElement>('[data-mf-src], [data-mf-poster]')) {
    for (const attr of ['src', 'poster']) {
      const abs = el.getAttribute(`data-mf-${attr}`)
      if (!abs) continue
      el.setAttribute(attr, encodePath(relative(outDir, abs)))
      el.removeAttribute(`data-mf-${attr}`)
      el.removeAttribute(`data-mf-orig-${attr}`)
    }
  }
  clone.querySelectorAll('[data-line]').forEach((el) => el.removeAttribute('data-line'))
  clone.querySelectorAll('[data-key], [data-state]').forEach((el) => {
    el.removeAttribute('data-key')
    el.removeAttribute('data-state')
  })
  return `<!doctype html>
<html lang="${document.documentElement.lang || 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="MarkFlow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${KATEX_CSS}">
<style>
${themeCss()}
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font-family: var(--font-reading); }
.markdown-body { max-width: 860px; margin: 0 auto; padding: 40px 32px 80px; font-size: 16px; }
${markdownCss}
${hljsThemes.light}
${scopeHljsDark(hljsThemes.dark)}
</style>
</head>
<body>
<article class="markdown-body">
${clone.innerHTML}
</article>
</body>
</html>
`
}
