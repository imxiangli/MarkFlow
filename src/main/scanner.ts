import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { IGNORED_DIRS, isBinaryFile, isImageFile, isMarkdownFile } from '@shared/constants'
import { extractHeadings } from '@shared/headings'
import { decodeText, looksBinary } from './textfile'
import type { ScanOptions, SearchFileResult, SearchMatch, SearchOptions, TreeNode } from '@shared/types'

const MAX_ENTRIES = 30000
const MAX_DEPTH = 32
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function isIgnoredName(name: string, options: ScanOptions): boolean {
  if (IGNORED_DIRS.includes(name)) return true
  if (!options.showHiddenFiles && name.startsWith('.')) return true
  return false
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

export async function scanFolder(root: string, options: ScanOptions): Promise<TreeNode> {
  let count = 0
  const visited = new Set<string>()

  async function walk(dir: string, depth: number): Promise<TreeNode[]> {
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) return []
    try {
      const real = await fs.realpath(dir)
      if (visited.has(real)) return []
      visited.add(real)
    } catch {
      return []
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: TreeNode[] = []
    for (const entry of entries) {
      if (count > MAX_ENTRIES) break
      const name = entry.name
      if (isIgnoredName(name, options)) continue
      const full = join(dir, name)
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(full)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch {
          continue
        }
      }
      if (isDir) {
        const children = await walk(full, depth + 1)
        let keep = options.showAllFiles || children.length > 0
        if (!keep) {
          // Keep genuinely empty folders visible (e.g. freshly created ones).
          try {
            const inner = await fs.readdir(full)
            keep = inner.filter((n) => !isIgnoredName(n, options)).length === 0
          } catch {
            keep = false
          }
        }
        if (keep) nodes.push({ name, path: full, type: 'dir', children })
        count++
      } else if (isFile) {
        if (options.showAllFiles || isMarkdownFile(name)) {
          nodes.push({ name, path: full, type: 'file' })
          count++
        }
      }
    }
    return sortNodes(nodes)
  }

  const children = await walk(root, 0)
  return { name: basename(root) || root, path: root, type: 'dir', children }
}

export function flattenFiles(node: TreeNode, out: string[] = []): string[] {
  if (node.type === 'file') out.push(node.path)
  else node.children?.forEach((c) => flattenFiles(c, out))
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MAX_FILE_SIZE = 5 * 1024 * 1024
const MAX_TOTAL_MATCHES = 5000
const MAX_MATCHES_PER_FILE = 200

export async function searchFolder(
  root: string,
  query: string,
  options: SearchOptions & ScanOptions
): Promise<SearchFileResult[]> {
  if (!query) return []
  let source = options.regex ? query : escapeRegExp(query)
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  let re: RegExp
  try {
    re = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  } catch {
    return []
  }
  // With "show all files" on, every text file in the tree is searched (binaries are skipped).
  const tree = await scanFolder(root, { showAllFiles: options.showAllFiles, showHiddenFiles: options.showHiddenFiles })
  const files = flattenFiles(tree).filter((f) => isMarkdownFile(f) || (!isBinaryFile(f) && !isImageFile(f)))
  const results: SearchFileResult[] = []
  let total = 0
  for (const file of files) {
    if (total >= MAX_TOTAL_MATCHES) break
    let content: string
    try {
      const st = await fs.stat(file)
      if (st.size > MAX_FILE_SIZE) continue
      const buf = await fs.readFile(file)
      if (!isMarkdownFile(file) && looksBinary(buf)) continue
      content = decodeText(buf).content
    } catch {
      continue
    }
    const matches: SearchMatch[] = []
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
      const line = lines[i]
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) && matches.length < MAX_MATCHES_PER_FILE) {
        if (m[0].length === 0) {
          re.lastIndex++
          continue
        }
        // Trim very long lines around the match for display.
        const start = Math.max(0, m.index - 60)
        const prefix = start > 0 ? '…' : ''
        const text = prefix + line.slice(start, m.index + m[0].length + 120)
        matches.push({
          line: i,
          column: m.index,
          length: m[0].length,
          text,
          textOffset: prefix.length + m.index - start
        })
      }
    }
    if (matches.length) {
      results.push({ path: file, matches })
      total += matches.length
    }
  }
  return results
}

export interface HeadingEntry {
  path: string
  line: number
  level: number
  text: string
}

const MAX_HEADINGS = 8000

/** Headings of every Markdown file in a folder (fenced code blocks skipped). */
export async function listHeadings(root: string, options: ScanOptions): Promise<HeadingEntry[]> {
  const tree = await scanFolder(root, { showAllFiles: false, showHiddenFiles: options.showHiddenFiles })
  const out: HeadingEntry[] = []
  for (const file of flattenFiles(tree)) {
    if (out.length >= MAX_HEADINGS) break
    let content: string
    try {
      const st = await fs.stat(file)
      if (st.size > 2 * 1024 * 1024) continue
      content = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const h of extractHeadings(content, MAX_HEADINGS - out.length)) out.push({ path: file, ...h })
  }
  return out
}
