/**
 * Guesses what a new, never saved document is from its text, so pasting a SQL script into a
 * fresh tab makes it a SQL document. Pure (no editor imports) so it can be tested in Node.
 *
 * Returns a document type name (a CodeMirror language-data name such as 'SQL') or null when the
 * text reads like prose / Markdown — Markdown is what a new document falls back to.
 */

/** Only the start of a long document is looked at. */
const SAMPLE_CHARS = 20_000
const SAMPLE_LINES = 400
/** A language needs at least this score, and to beat Markdown, to be picked. */
const THRESHOLD = 4

type Rule = [RegExp, number]

/** Per-line rules: every line matching a rule adds its weight (once per rule and line). */
const LINE_RULES: Record<string, Rule[]> = {
  SQL: [
    [/^\s*(SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+TABLE|REPLACE\s+INTO)\b/, 4],
    [/^\s*(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(TEMP(ORARY)?\s+)?(TABLE|VIEW|INDEX|UNIQUE\s+INDEX|DATABASE|SCHEMA|PROCEDURE|FUNCTION|TRIGGER|SEQUENCE|USER|ROLE)\b/, 5],
    [/^\s*(WITH\s+(RECURSIVE\s+)?\w+\s+AS\s*\(|GRANT\s+\w+|REVOKE\s+\w+|USE\s+\S+\s*;|BEGIN\s+TRANSACTION|COMMIT\s*;|ROLLBACK\s*;)/i, 4],
    [/^\s*select\s+(distinct\s+|top\s+\d+\s+)?(\*|[\w.`"[\]]+\s*,|count\s*\(|[\w.`"[\]]+\s+as\s+\w+|[\w.`"[\]]+\s+from\s+[\w.`"[\]]+\s*(where\b|;|$))/i, 4],
    [/^\s*(insert\s+into\s+[\w.`"[\]]+\s*(\(|values\b)|update\s+[\w.`"[\]]+\s+set\s+\w+\s*=|delete\s+from\s+[\w.`"[\]]+\s*(where\b|;|$))/i, 4],
    [/^\s*(create|alter|drop)\s+(table|view|index|database|schema)\s+(if\s+(not\s+)?exists\s+)?[\w.`"[\]]+/i, 4],
    [/\b(FROM|WHERE|INNER JOIN|LEFT JOIN|RIGHT JOIN|GROUP BY|ORDER BY|HAVING|VALUES|PRIMARY KEY|FOREIGN KEY|NOT NULL|DEFAULT|AUTO_INCREMENT|REFERENCES|LIMIT)\b/, 1],
    [/^\s*[\w`"[\]]+\s+(VARCHAR|NVARCHAR|CHAR|INT|INTEGER|BIGINT|SMALLINT|DECIMAL|NUMERIC|TIMESTAMP|DATETIME|DATE|BOOLEAN|TEXT|SERIAL)\s*(\(\d+(,\s*\d+)?\))?\s*(,|NOT\b|NULL\b|DEFAULT\b|PRIMARY\b|UNIQUE\b|$)/i, 1],
    [/^\s*--(\s|$)/, 1]
  ],
  Python: [
    [/^\s*(async\s+)?def\s+\w+\s*\(.*\)\s*(->\s*[^:]+)?:\s*(#.*)?$/, 4],
    [/^\s*class\s+\w+\s*(\(.*\))?\s*:\s*(#.*)?$/, 4],
    [/^\s*(from\s+[\w.]+\s+import\s+[\w*]|import\s+[\w.]+(\s+as\s+\w+)?(\s*,\s*[\w.]+(\s+as\s+\w+)?)*\s*$)/, 3],
    [/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/, 5],
    [/^\s*(elif\b.*|else|try|finally|except\b.*|with\b.*|for\s+.+\s+in\s+.+|while\b.+|if\b.+)\s*:\s*(#.*)?$/, 2],
    [/\bself\.\w+/, 1],
    [/^\s*print\(/, 1],
    [/^\s*(return|raise|yield|pass|None|True|False)\b/, 1],
    [/^\s*"""|^\s*'''/, 1]
  ],
  JavaScript: [
    [/^\s*import\s+([\w$*{][^'"]*\s+from\s+)?['"][^'"]+['"]\s*;?\s*$/, 4],
    [/^\s*export\s+(default\b|const\b|let\b|function\b|class\b|async\b|\{)/, 3],
    [/^\s*(const|let|var)\s+[\w${[]/, 2],
    [/\bfunction\s*\*?\s*[\w$]*\s*\(/, 2],
    [/\brequire\(\s*['"][^'"]+['"]\s*\)/, 3],
    [/=>/, 1],
    [/\bconsole\.\w+\(|\bdocument\.\w+|\bwindow\.\w+|\bmodule\.exports\b/, 2],
    [/\b(await|async)\b|\.then\(/, 1],
    [/===|!==/, 1]
  ],
  /** Added to the JavaScript score: TypeScript is JavaScript with these. */
  TypeScriptOnly: [
    [/^\s*(export\s+)?(declare\s+)?(interface|type)\s+\w+(<[^>]*>)?\s*(=|\{|extends\b)/, 4],
    [/^\s*(export\s+)?(declare\s+)?(const\s+)?(enum|namespace|abstract\s+class)\s+\w+/, 3],
    [/[\w)?]\s*:\s*(string|number|boolean|any|unknown|void|never|Record<|Promise<|Array<)\b/, 2],
    [/\b(private|public|protected|readonly)\s+\w+\s*[:(]/, 1],
    [/\bas\s+(const|string|number|any|unknown)\b/, 2]
  ],
  Java: [
    [/^\s*package\s+[\w.]+\s*;\s*$/, 5],
    [/^\s*import\s+(static\s+)?[\w.]+(\.\*)?\s*;\s*$/, 3],
    [/^\s*(public|private|protected)\s+(static\s+)?(final\s+)?(abstract\s+)?(class|interface|enum|record)\s+\w+/, 4],
    [/^\s*(public|private|protected)\s+(static\s+)?(final\s+)?(synchronized\s+)?[\w<>[\],\s]+\s+\w+\s*\([^)]*\)\s*(throws\s+[\w.,\s]+)?\{?\s*$/, 3],
    [/\bSystem\.(out|err)\.print/, 4],
    [/^\s*@(Override|Autowired|Service|Component|RestController|Test|Entity|Data)\b/, 2],
    [/\bnew\s+\w+(<[^>]*>)?\(/, 1]
  ],
  Go: [
    [/^\s*package\s+\w+\s*$/, 4],
    [/^\s*func\s+(\([^)]*\)\s*)?\w+\s*\(/, 4],
    [/^\s*import\s*(\(\s*$|"[^"]+"\s*$)/, 3],
    [/:=/, 1],
    [/\bfmt\.\w+\(|\berr\s*!=\s*nil\b/, 2],
    [/^\s*(type\s+\w+\s+(struct|interface)\s*\{|go\s+func\b|defer\s+)/, 3]
  ],
  Rust: [
    [/^\s*(pub\s+)?(async\s+)?fn\s+\w+\s*(<[^>]*>)?\(/, 4],
    [/\blet\s+mut\b/, 3],
    [/\b(println|eprintln|format|vec|panic)!\(/, 3],
    [/^\s*use\s+[\w:]+(::\{[^}]*\})?\s*;\s*$/, 3],
    [/^\s*(pub\s+)?(struct|enum|trait|mod)\s+\w+|^\s*impl\b/, 2]
  ],
  'C++': [
    [/^\s*#include\s*[<"][^>"]+[>"]/, 4],
    [/\bstd::|\b(cout|cin|endl)\b|^\s*using\s+namespace\s+\w+\s*;|^\s*template\s*</, 3],
    [/^\s*(int|void|char|double|float|long|unsigned|bool|auto)\s+\**\w+\s*\([^)]*\)\s*\{?\s*$/, 2],
    [/\bprintf\(|\bmalloc\(|\bsizeof\(/, 1]
  ],
  Shell: [
    [/^\s*(sudo|apt(-get)?|yum|dnf|brew|pip3?|npm|npx|yarn|pnpm|git|docker|docker-compose|kubectl|helm|systemctl|ssh|scp|rsync|chmod|chown|mkdir|curl|wget|tar|export|source|alias|echo)\s+\S/, 2],
    [/^\s*(if|elif|while|until|for)\s.*;\s*(then|do)\s*$|^\s*(fi|done|esac|then|do)\s*$/, 3],
    [/^\s*(cd|ls|rm|cp|mv|cat|grep|sed|awk|ln|touch|make)\s+-{0,2}[\w./~$"'-]/, 1],
    [/^\s*[A-Z_][A-Z0-9_]*=\S*\s*$|\$\{\w+[^}]*\}|\$\(.+\)/, 1],
    [/^\s*\w[\w-]*\s*\(\)\s*\{|\s(&&|\|\|)\s|\s\|\s|\s[12]?>\s*\/dev\/null|\\$/, 1]
  ],
  CSS: [
    [/^\s*@(media|import|keyframes|font-face|supports|charset|tailwind|layer)\b/, 4],
    [/^\s*(:root|html|body|\*|[.#][\w-]+|[a-z]+[.#:][\w-]+)([\s,>+~]+[.#:]?[\w-]+[\w\-.#:()[\]="]*)*\s*\{\s*$/, 2],
    [/^\s*(color|background(-color)?|margin(-\w+)?|padding(-\w+)?|display|font(-\w+)?|width|height|border(-\w+)?|position|top|left|right|bottom|flex(-\w+)?|grid(-\w+)?|z-index|opacity|transition|transform|line-height|text-\w+|box-shadow|overflow|cursor|gap|align-items|justify-content|--[\w-]+)\s*:\s*[^;]+;\s*$/, 2]
  ],
  Dockerfile: [
    [/^\s*FROM\s+[\w./:@${}-]+(\s+AS\s+\w+)?\s*$/i, 4],
    [/^\s*(RUN|CMD|COPY|ADD|WORKDIR|ENV|EXPOSE|ENTRYPOINT|ARG|LABEL|USER|VOLUME|HEALTHCHECK)\s+\S/, 3]
  ],
  Markdown: [
    // Weak: "# …" is also a comment in Python, Shell, YAML…
    [/^#{1,6}\s+\S/, 1],
    [/!?\[[^\]\n]+\]\([^)\s]+(\s+"[^"]*")?\)/, 2],
    [/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?\S/, 1],
    [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 1],
    [/`[^`\n]+`/, 1],
    [/^>\s?/, 1],
    [/^\s*\|.*\|\s*$/, 1],
    [/^\s*([-*_])(\s*\1){2,}\s*$/, 1]
  ]
}

/** Text with a fenced code block is Markdown, whatever the code inside. */
const FENCE = /^\s*(```|~~~)/m

const HTML_TAGS =
  /^<(html|head|body|div|span|p|a|ul|ol|li|table|thead|tbody|tr|td|th|form|input|button|section|article|header|footer|nav|main|aside|h[1-6]|img|script|style|link|meta|template|svg|label|select|textarea|br|hr|iframe|canvas|video|audio|pre|code|em|strong|b|i)\b/i

function sampleOf(content: string): string {
  let text = content.length > SAMPLE_CHARS ? content.slice(0, SAMPLE_CHARS) : content
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

function isJson(text: string, whole: string): boolean {
  if (!/^[[{]/.test(text)) return false
  // An object / array of at least one entry; "{}" or "[1]" alone isn't worth a type change.
  if (!/^(\{\s*"|\[\s*[[{"\d-]|\[\s*(true|false|null)\b)/.test(text)) return false
  if (whole.length > 2_000_000) return true
  try {
    JSON.parse(whole)
    return true
  } catch {
    return false
  }
}

/** Markup: the first tag decides between HTML and XML; both need a closing tag (or a doctype). */
function markupType(text: string): string | null {
  if (/^<\?php\b/i.test(text)) return 'PHP'
  if (/^<\?xml\b/i.test(text)) return 'XML'
  if (/^<!doctype\s+html\b/i.test(text)) return 'HTML'
  if (!/^<[a-zA-Z!]/.test(text)) return null
  if (!/<\/[\w:-]+\s*>|\/>/.test(text)) return null
  // Mostly markup, not a paragraph starting with an inline tag.
  const tagLines = text.split('\n').filter((l) => /^\s*<\/?[\w!:-]/.test(l)).length
  const lines = text.split('\n').filter((l) => l.trim()).length
  if (tagLines < Math.max(1, lines / 2)) return null
  return HTML_TAGS.test(text) || /^<!--/.test(text) ? 'HTML' : 'XML'
}

/** YAML: nearly every line is "key: value", "key:" or "- item", with some nesting. */
function yamlScore(lines: string[]): number {
  let keys = 0
  let nested = 0
  let other = 0
  for (const line of lines) {
    if (/^\s*(#|---\s*$|\.\.\.\s*$)/.test(line)) continue
    if (/^\s*(-\s+)?["']?[\w.$/-]+["']?\s*:(\s+\S.*)?$/.test(line)) {
      keys++
      if (/^\s+\S/.test(line) || /:\s*$/.test(line)) nested++
    } else if (/^\s*-\s+\S/.test(line)) {
      nested++
    } else if (/^\s+\S/.test(line) && keys) {
      // Continuation of a multi-line value.
    } else other++
  }
  if (keys < 2 || nested < 1 || other > (keys + nested) / 10) return 0
  return keys + nested
}

function lineScores(lines: string[]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const [lang, rules] of Object.entries(LINE_RULES)) {
    let score = 0
    for (const line of lines) {
      if (!line.trim()) continue
      for (const [re, weight] of rules) if (re.test(line)) score += weight
    }
    scores.set(lang, score)
  }
  const js = scores.get('JavaScript') ?? 0
  const tsOnly = scores.get('TypeScriptOnly') ?? 0
  scores.delete('TypeScriptOnly')
  if (tsOnly > 0) scores.set('TypeScript', js + tsOnly)
  return scores
}

/** The document type the text looks like, or null for prose / Markdown. */
export function detectContentType(content: string): string | null {
  const sample = sampleOf(content)
  const text = sample.trimStart()
  if (!text.trim()) return null
  const first = text.split('\n', 1)[0]

  if (first.startsWith('#!')) {
    if (/\b(ba|z|k|da|fi)?sh\b/.test(first)) return 'Shell'
    if (/\bpython[\d.]*\b/.test(first)) return 'Python'
    if (/\b(node|deno|bun)\b/.test(first)) return 'JavaScript'
    if (/\bruby\b/.test(first)) return 'Ruby'
    if (/\bperl\b/.test(first)) return 'Perl'
    if (/\bphp\b/.test(first)) return 'PHP'
  }
  if (FENCE.test(sample)) return null
  if (isJson(text, content.trim())) return 'JSON'
  const markup = markupType(text)
  if (markup) return markup

  const lines = sample.split('\n', SAMPLE_LINES).map((l) => l.replace(/\r$/, ''))
  const scores = lineScores(lines)
  const yaml = yamlScore(lines)
  if (yaml) scores.set('YAML', yaml * 2)

  const markdown = scores.get('Markdown') ?? 0
  scores.delete('Markdown')
  let best: string | null = null
  let bestScore = 0
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      best = lang
      bestScore = score
    }
  }
  if (!best || bestScore < THRESHOLD || bestScore <= markdown) return null
  return best
}
