import { useEffect, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, FileText, Regex, WholeWord } from 'lucide-react'
import type { SearchFileResult } from '@shared/types'
import { openFile } from '@/actions'
import { useT } from '@/lib/i18n'
import { basename, dirname, relative } from '@/lib/path'
import { getState, setState, useStore } from '@/store'

export function SearchPanel() {
  const t = useT()
  const root = useStore((s) => s.root)
  const settings = useStore((s) => s.settings)
  const focusSeq = useStore((s) => s.searchFocusSeq)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  const [results, setResults] = useState<SearchFileResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const seq = useRef(0)

  useEffect(() => {
    const seed = getState().searchSeed
    if (seed !== null) {
      setState({ searchSeed: null })
      setQuery(seed)
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSeq])

  // ⌥⌘R / ⌥⌘C / ⌥⌘W while the search field has focus.
  useEffect(() => {
    const onToggle = (e: Event) => {
      const option = (e as CustomEvent<string>).detail
      const k = option === 'regexp' ? 'regex' : option
      if (k === 'regex' || k === 'caseSensitive' || k === 'wholeWord') setOpts((o) => ({ ...o, [k]: !o[k] }))
    }
    window.addEventListener('mf-search-toggle', onToggle)
    return () => window.removeEventListener('mf-search-toggle', onToggle)
  }, [])

  useEffect(() => {
    if (!root || !query.trim()) {
      setResults(null)
      return
    }
    const id = ++seq.current
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const r = await window.mf.searchInFolder(root, query, {
          ...opts,
          showAllFiles: settings.showAllFiles,
          showHiddenFiles: settings.showHiddenFiles
        })
        if (id === seq.current) setResults(r)
      } finally {
        if (id === seq.current) setBusy(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [root, query, opts, settings.showAllFiles, settings.showHiddenFiles])

  if (!root) return <div className="sidebar-empty">{t('search.noFolder')}</div>

  const total = results?.reduce((n, r) => n + r.matches.length, 0) ?? 0
  const toggle = (k: keyof typeof opts) => setOpts((o) => ({ ...o, [k]: !o[k] }))

  return (
    <div className="search-panel">
      <div className="search-box">
        <input
          ref={inputRef}
          value={query}
          placeholder={t('search.placeholder')}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="search-opts">
          <button className={opts.caseSensitive ? 'on' : ''} title={t('search.caseSensitive')} onClick={() => toggle('caseSensitive')}>
            <CaseSensitive size={15} />
          </button>
          <button className={opts.wholeWord ? 'on' : ''} title={t('search.wholeWord')} onClick={() => toggle('wholeWord')}>
            <WholeWord size={15} />
          </button>
          <button className={opts.regex ? 'on' : ''} title={t('search.regex')} onClick={() => toggle('regex')}>
            <Regex size={15} />
          </button>
        </div>
      </div>
      <div className="search-summary">
        {busy
          ? t('search.searching')
          : results
            ? results.length
              ? t('search.summary', { count: total, files: results.length })
              : t('search.noResults')
            : ''}
      </div>
      <div className="search-results">
        {results?.map((r) => {
          const isCollapsed = collapsed[r.path]
          const rel = relative(root, dirname(r.path))
          return (
            <div key={r.path} className="search-file">
              <div className="search-file-head" onClick={() => setCollapsed((c) => ({ ...c, [r.path]: !c[r.path] }))} title={r.path}>
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <FileText size={14} />
                <span className="search-file-name">{basename(r.path)}</span>
                {rel !== '.' && <span className="search-file-dir">{rel}</span>}
                <span className="search-count">{r.matches.length}</span>
              </div>
              {!isCollapsed &&
                r.matches.map((m, i) => (
                  <div
                    key={i}
                    className="search-match"
                    onClick={() => void openFile(r.path, { line: m.line, column: m.column, length: m.length })}
                  >
                    <span className="search-line-no">{m.line + 1}</span>
                    <span className="search-text">
                      {m.text.slice(0, m.textOffset)}
                      <mark>{m.text.slice(m.textOffset, m.textOffset + m.length)}</mark>
                      {m.text.slice(m.textOffset + m.length)}
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
