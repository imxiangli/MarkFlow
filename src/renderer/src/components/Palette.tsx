import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Clock, Code, Command, Hash, Heading, ListOrdered } from 'lucide-react'
import { flattenTree, openFile, requestReveal, runMenuCommand, setDocumentType, setTabLanguage } from '@/actions'
import { editorBridge } from '@/editor/bridge'
import { DOCUMENT_TYPES, PLAIN_TEXT, SYNTAXES, documentType, typeExtension } from '@/editor/languages'
import { useT } from '@/lib/i18n'
import { currentLocation } from '@/lib/navHistory'
import { basename, dirname, relative } from '@/lib/path'
import { activeTab, getState, isEditable, isNewDocument, setState, useStore } from '@/store'
import { extractHeadings, type SourceHeading } from '@shared/headings'
import { COMMANDS, displayKey, keyOf } from '@shared/keybindings'
import type { HeadingEntry, MenuCommand } from '@shared/types'
import { paletteMode, parseFileQuery, rank } from '@/lib/fuzzy'
import { FileIcon } from './FileIcon'

interface Row {
  key: string
  icon: ReactNode
  label: string
  detail?: string
  badge?: string
  indent?: number
  run: () => void
}

const RECENT_COMMANDS_KEY = 'markflow.palette.recentCommands'

function recentCommands(): MenuCommand[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function rememberCommand(id: MenuCommand): void {
  try {
    const list = [id, ...recentCommands().filter((x) => x !== id)].slice(0, 8)
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(list))
  } catch {
    // Storage may be unavailable; the order just isn't remembered.
  }
}

/** Headings of the active document, read from the source so they work in every view mode. */
function activeHeadings(): { tabId: string; headings: SourceHeading[] } | null {
  const tab = activeTab(getState())
  if (!tab || tab.kind !== 'markdown' || tab.large) return null
  const content = editorBridge.getContent(tab.id) ?? tab.content
  return { tabId: tab.id, headings: extractHeadings(content) }
}

function lineCount(): number {
  const tab = activeTab(getState())
  if (!isEditable(tab)) return 0
  const doc = editorBridge.getDoc(tab!.id)
  if (doc) return doc.lines
  return tab!.content.split('\n').length
}

async function openAtHeading(path: string, query: string): Promise<void> {
  const tab = await openFile(path)
  if (!tab || tab.kind !== 'markdown' || !query) return
  const best = rank(extractHeadings(tab.content), query, (h) => h.text, 1)[0]
  if (best) requestReveal(tab.id, { line: best.line })
}

/** Goto Anything (⌘P), command palette (⇧⌘P), go to heading (⌘R / ⇧⌘R) and go to line (⌃G). */
export function Palette() {
  const initial = useStore((s) => s.palette)
  if (initial === null) return null
  // A fresh body per opening: state starts from `initial` and the input is focused on mount,
  // so keys typed right after ⌘P / ⇧⌘P are never lost.
  return <PaletteBody key={initial} initial={initial} />
}

function PaletteBody({ initial }: { initial: string }) {
  const t = useT()
  const tree = useStore((s) => s.tree)
  const root = useStore((s) => s.root)
  const recent = useStore((s) => s.recent)
  const platform = useStore((s) => s.platform)
  const showHiddenFiles = useStore((s) => s.settings.showHiddenFiles)
  // Snapshots taken when the palette opens (before the input steals focus).
  const [prevFocus] = useState(() => document.activeElement as HTMLElement | null)
  const [doc] = useState(activeHeadings)
  const [syntaxTab] = useState(() => activeTab(getState()))
  const [lines] = useState(lineCount)
  const [query, setQuery] = useState(initial)
  const [index, setIndex] = useState(() => {
    // "@" with no query starts on the heading the reader is in.
    if (initial !== '@' || !doc) return 0
    const here = currentLocation()?.line ?? 0
    let start = 0
    doc.headings.forEach((h, i) => {
      if (h.line <= here) start = i
    })
    return start
  })
  const [project, setProject] = useState<HeadingEntry[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mode = paletteMode(query)

  useEffect(() => {
    if (mode !== 'project' || project || !root) return
    let alive = true
    void window.mf.listHeadings(root, { showAllFiles: false, showHiddenFiles }).then((list) => alive && setProject(list))
    return () => {
      alive = false
    }
  }, [mode, project, root, showHiddenFiles])

  const files = useMemo(() => {
    const list = flattenTree(tree).map((f) => ({
      path: f.path,
      label: f.name,
      detail: root ? relative(root, dirname(f.path)) : dirname(f.path),
      recent: false
    }))
    const known = new Set(list.map((f) => f.path))
    const rec = recent
      .filter((r) => r.kind === 'file' && !known.has(r.path))
      .map((r) => ({ path: r.path, label: basename(r.path), detail: dirname(r.path), recent: true }))
    return [...rec, ...list]
  }, [tree, root, recent])

  const close = (restoreFocus = true) => {
    setState({ palette: null })
    if (restoreFocus) prevFocus?.focus?.()
  }

  const { rows, empty } = useMemo((): { rows: Row[]; empty: string } => {
    const q = query.slice(mode === 'files' ? 0 : 1).trim()
    switch (mode) {
      case 'commands': {
        const order = recentCommands()
        const defs = COMMANDS.filter((d) => !d.hidden)
          .map((d) => ({ d, label: t(d.label, d.labelVars), group: t(d.group), recent: order.indexOf(d.id) }))
          .sort((a, b) => (a.recent < 0 ? 99 : a.recent) - (b.recent < 0 ? 99 : b.recent))
        const ranked = rank(defs, q, (x) => `${x.group}: ${x.label} ${x.d.id}`, 200)
        // Sublime's "Set Syntax: …" entries for code / text files; for a new document, its type.
        const syntaxRows: Row[] = []
        const newDoc = isNewDocument(syntaxTab)
        const setLabel = (name: string) => t(newDoc ? 'cmd.setType' : 'cmd.setSyntax', { name })
        const prefix = setLabel('').trim()
        const syntaxFirst = q.startsWith(prefix)
        // Only the part after the prefix filters, so the list keeps its order until you type.
        const filter = syntaxFirst ? q.slice(prefix.length).trim() : q
        if (syntaxTab && newDoc) {
          const current = documentType(syntaxTab, syntaxTab.content)
          const choices = DOCUMENT_TYPES.map((type) => ({ type, name: type === PLAIN_TEXT ? t('status.plainText') : type }))
          for (const c of rank(choices, filter, (x) => setLabel(x.name), 200)) {
            const ext = typeExtension(c.type)
            syntaxRows.push({
              key: `type:${c.type}`,
              icon: <Code size={14} />,
              label: setLabel(c.name),
              detail: ext && `.${ext}`,
              badge: c.type === current ? '✓' : undefined,
              run: () => {
                close()
                setDocumentType(syntaxTab.id, c.type)
              }
            })
          }
        } else if (syntaxTab?.kind === 'text' || syntaxTab?.large) {
          const choices: { value: string | undefined; name: string }[] = [
            { value: undefined, name: t('cmd.syntaxAuto') },
            { value: 'plain', name: t('status.plainText') },
            ...SYNTAXES.map((l) => ({ value: l.name, name: l.name }))
          ]
          for (const c of rank(choices, filter, (x) => setLabel(x.name), 200)) {
            syntaxRows.push({
              key: `syntax:${c.value ?? ''}`,
              icon: <Code size={14} />,
              label: setLabel(c.name),
              badge: syntaxTab.language === c.value ? '✓' : undefined,
              run: () => {
                close()
                setTabLanguage(syntaxTab.id, c.value)
              }
            })
          }
        }
        return {
          empty: t('quick.noResults'),
          rows: [...(syntaxFirst ? syntaxRows : []), ...ranked.map(({ d, label, group, recent: r }) => ({
            key: d.id,
            icon: r >= 0 && !q ? <Clock size={14} /> : <Command size={14} />,
            label: `${group}: ${label}`,
            badge: displayKey(keyOf(d.id, platform), platform),
            run: () => {
              rememberCommand(d.id)
              close()
              setTimeout(() => runMenuCommand(d.id), 0)
            }
          })), ...(syntaxFirst || !q ? [] : syntaxRows)]
        }
      }
      case 'headings': {
        if (!doc) return { rows: [], empty: syntaxTab?.large ? t('large.noHeadings') : t('palette.noDoc') }
        const min = Math.min(...doc.headings.map((h) => h.level))
        return {
          empty: t('palette.noHeadings'),
          rows: rank(doc.headings, q, (h) => h.text, 500).map((h) => ({
            key: `${h.line}`,
            icon: <Heading size={14} />,
            label: h.text,
            badge: `H${h.level}`,
            detail: `:${h.line + 1}`,
            indent: q ? 0 : h.level - min,
            run: () => {
              close()
              requestReveal(doc.tabId, { line: h.line })
            }
          }))
        }
      }
      case 'project': {
        if (!root) return { rows: [], empty: t('palette.noFolder') }
        if (!project) return { rows: [], empty: t('palette.loading') }
        return {
          empty: t('palette.noHeadings'),
          rows: rank(project, q, (h) => `${h.text} ${basename(h.path)}`, 200).map((h) => ({
            key: `${h.path}:${h.line}`,
            icon: <Hash size={14} />,
            label: h.text,
            detail: `${relative(root, h.path)}:${h.line + 1}`,
            badge: `H${h.level}`,
            run: () => {
              close()
              void openFile(h.path, { line: h.line })
            }
          }))
        }
      }
      case 'line': {
        const tab = activeTab(getState())
        if (!tab || !isEditable(tab)) return { rows: [], empty: t('palette.noDoc') }
        const m = /^(\d+)(?::(\d+))?$/.exec(q)
        if (!m) return { rows: [], empty: t('palette.lineHint', { n: lines }) }
        const line = Math.max(1, Math.min(lines, Number(m[1])))
        const column = m[2] ? Math.max(1, Number(m[2])) : undefined
        return {
          empty: '',
          rows: [
            {
              key: 'line',
              icon: <ListOrdered size={14} />,
              label: t('palette.gotoLine', { line: column ? `${line}:${column}` : line }),
              detail: t('palette.lineHint', { n: lines }),
              run: () => {
                close()
                requestReveal(tab.id, { line: line - 1, column: column ? column - 1 : undefined })
              }
            }
          ]
        }
      }
      default: {
        const { file, line, column, heading } = parseFileQuery(q)
        const ranked = rank(files, file, (f) => (f.detail && f.detail !== '.' ? f.detail + '/' : '') + f.label, 80)
        return {
          empty: t('quick.noResults'),
          rows: ranked.map((f) => ({
            key: f.path,
            icon: f.recent ? <Clock size={14} /> : <FileIcon name={f.label} size={14} />,
            label: f.label + (line ? `:${line}${column ? `:${column}` : ''}` : heading !== undefined ? `@${heading}` : ''),
            detail: f.detail === '.' ? '' : f.detail,
            badge: f.recent ? t('quick.recent') : undefined,
            run: () => {
              close()
              if (heading !== undefined) void openAtHeading(f.path, heading.trim())
              else void openFile(f.path, line ? { line: line - 1, column: column ? column - 1 : undefined } : {})
            }
          }))
        }
      }
    }
    // close() only touches refs / the store, so it doesn't need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, files, doc, syntaxTab, project, root, lines, platform, t])

  useEffect(() => {
    listRef.current?.querySelector('.qo-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [index, rows])

  const placeholder = {
    files: t('palette.files'),
    commands: t('palette.commands'),
    headings: t('palette.headings'),
    project: t('palette.project'),
    line: t('palette.line')
  }[mode]
  const page = 10
  const mac = platform === 'darwin'

  return (
    <div className="modal-backdrop top" onMouseDown={() => close()}>
      <div className={`quick-open palette mode-${mode}`} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            const last = rows.length - 1
            if (e.key === 'ArrowDown' || (mac && e.ctrlKey && e.key === 'n')) {
              e.preventDefault()
              setIndex((i) => (i >= last ? 0 : i + 1))
            } else if (e.key === 'ArrowUp' || (mac && e.ctrlKey && e.key === 'p')) {
              e.preventDefault()
              setIndex((i) => (i <= 0 ? Math.max(0, last) : i - 1))
            } else if (e.key === 'PageDown') {
              e.preventDefault()
              setIndex((i) => Math.min(last, i + page))
            } else if (e.key === 'PageUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - page))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              rows[Math.min(index, last)]?.run()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <div className="qo-list" ref={listRef}>
          {rows.length === 0 && empty && <div className="qo-empty">{empty}</div>}
          {rows.map((row, i) => (
            <div
              key={row.key}
              className={`qo-item${i === index ? ' active' : ''}`}
              style={row.indent ? { paddingLeft: 10 + row.indent * 14 } : undefined}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                row.run()
              }}
            >
              {row.icon}
              <span className="qo-label">{row.label}</span>
              <span className="qo-detail">{row.detail}</span>
              {row.badge && <span className={mode === 'commands' ? 'qo-badge qo-key' : 'qo-badge'}>{row.badge}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
