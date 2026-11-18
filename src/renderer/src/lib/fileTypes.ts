/** File categories for icons and the binary view's type label (by extension / name only). */
import { extOf, isImageFile, isMarkdownFile } from '@shared/constants'
import { detectLanguage } from '@/editor/languages'

export type FileCategory =
  | 'markdown'
  | 'image'
  | 'code'
  | 'json'
  | 'shell'
  | 'spreadsheet'
  | 'text'
  | 'archive'
  | 'executable'
  | 'document'
  | 'audio'
  | 'video'
  | 'font'
  | 'database'
  | 'data'

const GROUPS: [FileCategory, string[]][] = [
  ['archive', ['zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'apk', 'ipa', 'dmg', 'iso', 'pkg', 'deb', 'rpm', 'msi', 'cab']],
  ['executable', ['exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'wasm', 'app', 'bin']],
  ['document', ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'odt', 'odp', 'pages', 'key', 'epub', 'mobi', 'rtf']],
  ['spreadsheet', ['xls', 'xlsx', 'ods', 'numbers', 'csv', 'tsv']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'aiff', 'mid', 'midi']],
  ['video', ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', '3gp']],
  ['image', ['psd', 'ai', 'sketch', 'fig', 'xcf', 'tif', 'tiff', 'heic', 'heif', 'raw', 'cr2', 'nef', 'dng', 'icns']],
  ['font', ['ttf', 'otf', 'woff', 'woff2', 'eot']],
  ['database', ['sqlite', 'sqlite3', 'db', 'mdb', 'accdb', 'parquet']],
  ['json', ['json', 'jsonc', 'json5', 'ipynb']],
  ['text', ['txt', 'log', 'text', 'out', 'nfo']]
]
const BY_EXT = new Map<string, FileCategory>(GROUPS.flatMap(([cat, exts]) => exts.map((e) => [e, cat] as const)))

export function fileCategory(name: string): FileCategory {
  if (isMarkdownFile(name)) return 'markdown'
  if (isImageFile(name)) return 'image'
  const cat = BY_EXT.get(extOf(name))
  if (cat) return cat
  const lang = detectLanguage(name)
  if (lang) return lang.name === 'Shell' || lang.name === 'PowerShell' ? 'shell' : 'code'
  return extOf(name) ? 'data' : 'text'
}

/** Human readable size: 1.2 MB. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
