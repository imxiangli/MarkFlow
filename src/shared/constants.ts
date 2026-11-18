import type { TextEncoding } from './types'

export const MARKDOWN_EXTENSIONS = [
  'md',
  'markdown',
  'mdown',
  'mkd',
  'mkdn',
  'mdwn',
  'mdtxt',
  'mdtext',
  'mdx',
  'rmd',
  'qmd'
]

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng']

/**
 * Formats that are never text: opened in the binary view without reading their content.
 * Anything not listed here (and not Markdown / an image) is sniffed when opened.
 */
export const BINARY_EXTENSIONS = [
  // archives & packages
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'apk', 'ipa', 'dmg', 'iso', 'pkg', 'deb', 'rpm', 'msi', 'cab',
  // executables & libraries
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'wasm', 'bin', 'dat',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub', 'mobi',
  // media
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'aiff', 'mid', 'midi',
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', '3gp',
  'psd', 'ai', 'sketch', 'fig', 'xcf', 'tif', 'tiff', 'heic', 'heif', 'raw', 'cr2', 'nef', 'dng', 'icns',
  // fonts & data
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'sqlite', 'sqlite3', 'db', 'mdb', 'accdb', 'parquet', 'npy', 'pt', 'onnx'
]

/** Extensions shown with a code icon / opened as text without sniffing doubts. */
export const TEXT_EXTENSIONS = [
  'txt',
  'json',
  'yaml',
  'yml',
  'toml',
  'csv',
  'log',
  'ini',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sh',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'rb',
  'php',
  'sql'
]

/** Directories that are never scanned or watched. */
export const IGNORED_DIRS = ['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store', '.Trash', '$RECYCLE.BIN']

export const ASSET_SCHEME = 'mf-asset'

/** Display names for the status bar and the encoding menu. */
export const ENCODING_LABELS: Record<TextEncoding, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 with BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  gb18030: 'GB18030',
  big5: 'Big5',
  shift_jis: 'Shift_JIS',
  'euc-kr': 'EUC-KR',
  'windows-1252': 'Windows-1252'
}


export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extOf(name))
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(extOf(name))
}

export function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.includes(extOf(name))
}

export function isBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.includes(extOf(name))
}

/** Build a URL for the privileged local-asset protocol from an absolute path. */
export function toAssetUrl(absPath: string): string {
  let p = absPath.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  return `${ASSET_SCHEME}://local` + p.split('/').map(encodeURIComponent).join('/')
}
