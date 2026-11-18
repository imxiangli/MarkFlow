/**
 * Minimal cross-platform path helpers for the renderer (no Node.js available).
 * Accepts both "/" and "\" separators; output keeps the style of the input.
 */

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/

export function isWindowsPath(p: string): boolean {
  return WIN_DRIVE.test(p) || p.startsWith('\\\\')
}

function sepOf(p: string): string {
  return isWindowsPath(p) ? '\\' : '/'
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/') || WIN_DRIVE.test(p) || p.startsWith('\\\\')
}

function splitRoot(p: string): { root: string; rest: string } {
  const m = /^([a-zA-Z]:)[\\/]?/.exec(p)
  if (m) return { root: m[1] + '\\', rest: p.slice(m[0].length) }
  if (p.startsWith('\\\\') || p.startsWith('//')) {
    const parts = p.slice(2).split(/[\\/]/)
    const root = '\\\\' + parts.slice(0, 2).join('\\') + '\\'
    return { root, rest: parts.slice(2).join('/') }
  }
  if (p.startsWith('/')) return { root: '/', rest: p.slice(1) }
  return { root: '', rest: p }
}

export function normalize(p: string): string {
  const sep = sepOf(p)
  const { root, rest } = splitRoot(p)
  const out: string[] = []
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!root) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join(sep)
  return (root ? root.replace(/[\\/]/g, sep) : '') + joined || (root ? root : '.')
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((p) => p !== '')
  if (!filtered.length) return '.'
  const sep = sepOf(filtered[0])
  return normalize(filtered.join(sep))
}

export function resolve(base: string, p: string): string {
  return isAbsolute(p) ? normalize(p) : join(base, p)
}

export function dirname(p: string): string {
  const { root, rest } = splitRoot(p)
  const trimmed = rest.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i < 0) return root || '.'
  return root + trimmed.slice(0, i)
}

export function basename(p: string, ext?: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  let b = trimmed.slice(i + 1)
  if (ext && b.toLowerCase().endsWith(ext.toLowerCase()) && b.length > ext.length) b = b.slice(0, -ext.length)
  return b
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i) : ''
}

function samePart(a: string, b: string, insensitive: boolean): boolean {
  return insensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Relative path from directory `from` to `to` (both absolute). Uses "/" separators. */
export function relative(from: string, to: string): string {
  const insensitive = isWindowsPath(from) || isWindowsPath(to)
  const a = normalize(from).split(/[\\/]+/).filter(Boolean)
  const b = normalize(to).split(/[\\/]+/).filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && samePart(a[i], b[i], insensitive)) i++
  if (i === 0 && insensitive) return to
  const up = a.slice(i).map(() => '..')
  return [...up, ...b.slice(i)].join('/') || '.'
}

export function isInside(child: string, parent: string): boolean {
  const insensitive = isWindowsPath(parent)
  const c = normalize(child)
  const p = normalize(parent).replace(/[\\/]+$/, '')
  const cc = insensitive ? c.toLowerCase() : c
  const pp = insensitive ? p.toLowerCase() : p
  return cc === pp || cc.startsWith(pp + '/') || cc.startsWith(pp + '\\')
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const insensitive = isWindowsPath(a) || navigatorIsMac()
  const na = normalize(a)
  const nb = normalize(b)
  return insensitive ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

function navigatorIsMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}

/** Converts a file:// URL into a local path. */
export function fileUrlToPath(url: string): string {
  const u = new URL(url)
  let p = decodeURIComponent(u.pathname)
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\')
  if (u.host && u.host !== 'localhost') p = '\\\\' + u.host + p.replace(/\//g, '\\')
  return p
}
