/**
 * Syntax highlighting for text / code tabs: picks a CodeMirror language from the file name,
 * a few well-known file names and the shebang line, and loads it on demand.
 */
import type { Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/** Every selectable syntax, sorted by name. */
export const SYNTAXES: readonly LanguageDescription[] = [...languages].sort((a, b) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
)

/** Files language-data doesn't recognise, by lower-case base name. */
const BY_FILENAME: Record<string, string> = {
  '.bashrc': 'Shell',
  '.bash_profile': 'Shell',
  '.bash_aliases': 'Shell',
  '.bash_logout': 'Shell',
  '.zshrc': 'Shell',
  '.zshenv': 'Shell',
  '.zprofile': 'Shell',
  '.profile': 'Shell',
  '.envrc': 'Shell',
  makefile: 'Shell',
  gnumakefile: 'Shell',
  procfile: 'Shell',
  gemfile: 'Ruby',
  rakefile: 'Ruby',
  podfile: 'Ruby',
  vagrantfile: 'Ruby',
  brewfile: 'Ruby',
  jenkinsfile: 'Groovy',
  '.env': 'Properties files',
  '.editorconfig': 'Properties files',
  '.gitconfig': 'Properties files',
  '.gitattributes': 'Properties files',
  '.gitignore': 'Properties files',
  '.dockerignore': 'Properties files',
  '.npmrc': 'Properties files',
  '.yarnrc': 'YAML',
  '.babelrc': 'JSON',
  '.eslintrc': 'JSON',
  '.prettierrc': 'JSON'
}

/** Extra extensions, lower case. */
const BY_EXTENSION: Record<string, string> = {
  jsonc: 'JSON',
  json5: 'JSON',
  ipynb: 'JSON',
  webmanifest: 'JSON',
  svelte: 'HTML',
  astro: 'HTML',
  zsh: 'Shell',
  fish: 'Shell',
  command: 'Shell',
  env: 'Properties files',
  conf: 'Properties files',
  cfg: 'Properties files',
  plist: 'XML',
  xsd: 'XML',
  xsl: 'XML',
  xslt: 'XML',
  csproj: 'XML',
  vcxproj: 'XML',
  storyboard: 'XML',
  xib: 'XML',
  kts: 'Kotlin',
  mk: 'Shell',
  bats: 'Shell'
}

const SHEBANG: [RegExp, string][] = [
  [/\b(ba|z|k|da|fi)?sh\b/, 'Shell'],
  [/\bpython[\d.]*\b/, 'Python'],
  [/\b(node|deno|bun)\b/, 'JavaScript'],
  [/\bruby\b/, 'Ruby'],
  [/\bperl\b/, 'Perl'],
  [/\bphp\b/, 'PHP'],
  [/\blua\b/, 'Lua'],
  [/\bRscript\b/, 'R'],
  [/\bpwsh\b/, 'PowerShell']
]

const byName = (name: string) => languages.find((l) => l.name === name) ?? null

/** The syntax for a file, or null for plain text. */
export function detectLanguage(fileName: string, content = ''): LanguageDescription | null {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
  const lower = base.toLowerCase()
  if (BY_FILENAME[lower]) return byName(BY_FILENAME[lower])
  if (lower.startsWith('.env.')) return byName('Properties files')
  const found = LanguageDescription.matchFilename(languages, base)
  if (found) return found
  const dot = lower.lastIndexOf('.')
  if (dot > 0 && BY_EXTENSION[lower.slice(dot + 1)]) return byName(BY_EXTENSION[lower.slice(dot + 1)])
  const first = content.slice(0, 200).split('\n', 1)[0]
  if (first.startsWith('#!')) {
    for (const [re, lang] of SHEBANG) if (re.test(first)) return byName(lang)
  }
  if (/^\s*<\?xml\b/.test(first)) return byName('XML')
  return null
}

/** The syntax of a text tab: the user's choice ('plain' = none) or the detected one. */
export function tabLanguage(tab: { name: string; language?: string }, content: string): LanguageDescription | null {
  if (tab.language === 'plain') return null
  if (tab.language) return byName(tab.language)
  return detectLanguage(tab.name, content)
}

export const PLAIN_TEXT = 'plain'
export const MARKDOWN_TYPE = 'Markdown'

/** Offered first when choosing what a new document is. */
export const COMMON_TYPES: readonly string[] = [
  PLAIN_TEXT,
  MARKDOWN_TYPE,
  'HTML',
  'JavaScript',
  'TypeScript',
  'JSON',
  'CSS',
  'Python',
  'Java',
  'Go',
  'Shell',
  'SQL',
  'YAML',
  'XML'
]

/** Every type a new document can have: the common ones, then all syntaxes by name. */
export const DOCUMENT_TYPES: readonly string[] = [
  ...COMMON_TYPES,
  ...SYNTAXES.map((l) => l.name).filter((name) => !COMMON_TYPES.includes(name))
]

/** Where the first extension language-data lists isn't the one to name a new file with. */
const TYPE_EXTENSION: Record<string, string> = {
  [PLAIN_TEXT]: 'txt',
  Python: 'py',
  LaTeX: 'tex',
  sTeX: 'tex',
  APL: 'apl',
  Brainfuck: 'bf',
  Fortran: 'f90',
  NSIS: 'nsi',
  Pascal: 'pas',
  SystemVerilog: 'sv',
  XQuery: 'xquery',
  'MariaDB SQL': 'sql',
  'MS SQL': 'sql',
  MySQL: 'sql',
  PostgreSQL: 'sql',
  SQLite: 'sql',
  Nginx: 'conf',
  'Angular Template': 'html'
}

/** The extension of a document type ('' for types without one, like Dockerfile). */
export function typeExtension(type: string): string {
  return TYPE_EXTENSION[type] ?? byName(type)?.extensions[0] ?? ''
}

/** A new document's name for a type: "Untitled-1.md" → "Untitled-1.html". */
export function nameForType(name: string, type: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = typeExtension(type)
  return ext ? `${stem}.${ext}` : stem
}

/** What a new document is at the moment: MARKDOWN_TYPE, a syntax name or PLAIN_TEXT. */
export function documentType(tab: { kind: string; name: string; language?: string }, content = ''): string {
  if (tab.kind === 'markdown') return MARKDOWN_TYPE
  return tabLanguage(tab, content)?.name ?? PLAIN_TEXT
}

/**
 * The syntax override of a new document once it has a file name. The file name decides from then
 * on (".py" after choosing JavaScript), unless it says nothing or several syntaxes share it (".m").
 */
export function languageAfterSave(language: string | undefined, fileName: string): string | undefined {
  if (!language) return undefined
  const detected = detectLanguage(fileName)
  if (!detected) return language
  if (detected.name === language) return undefined
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  return ext === typeExtension(language) || byName(language)?.extensions.includes(ext) ? language : undefined
}

/**
 * The loaded language extension, if any. When the language still has to be downloaded,
 * returns [] now and calls `onLoad` with the extension once it's ready.
 */
export function languageExtension(desc: LanguageDescription | null, onLoad: (ext: Extension) => void): Extension {
  if (!desc) return []
  if (desc.support) return desc.support
  desc.load().then(onLoad, (err) => console.warn(`[language] ${desc.name}`, err))
  return []
}
