import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { findPattern, type FindOptions } from '@/lib/find'
import { pulseRange } from '@/lib/findPulse'
import { setState, useStore } from '@/store'

/** Find-in-page for the rendered preview, using the CSS Custom Highlight API. */
export function FindBar() {
  const t = useT()
  const open = useStore((s) => s.findOpen)
  const [query, setQuery] = useState('')
  const [opts, setOpts] = useState<FindOptions>({ caseSensitive: false, wholeWord: false, regexp: false })
  const [invalid, setInvalid] = useState(false)
  const seed = useStore((s) => s.findSeed)
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const ranges = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const clear = () => {
    CSS.highlights?.delete('mf-find')
    CSS.highlights?.delete('mf-find-current')
  }

  const pulseTimer = useRef(0)
  const reveal = useCallback((i: number, pulseDelay = 0) => {
    const r = ranges.current[i]
    clearTimeout(pulseTimer.current)
    if (!r) {
      CSS.highlights?.delete('mf-find-current')
      return
    }
    CSS.highlights?.set('mf-find-current', new Highlight(r))
    const scroller = document.querySelector<HTMLElement>('.preview-scroll')
    if (!scroller) return
    const rect = r.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    // Centre a match that is off screen or tucked under the find bar / window edge.
    if (rect.top < box.top + 70 || rect.bottom > box.bottom - 40) {
      scroller.scrollTop += rect.top - box.top - (box.height - rect.height) / 2
    }
    // While typing, wait for a pause; stepping zooms right away.
    if (pulseDelay) pulseTimer.current = window.setTimeout(() => pulseRange(r), pulseDelay)
    else pulseRange(r)
  }, [])

  const search = useCallback(
    (keepIndex = false) => {
      clear()
      ranges.current = []
      const body = document.querySelector('.markdown-body')
      if (!body || !query) {
        setCount(0)
        return
      }
      const re = findPattern(query, opts)
      setInvalid(!re)
      if (!re) {
        setCount(0)
        return
      }
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          (n.parentElement?.closest('.mf-diagram-source, .katex-mathml, .mf-code-tools') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
      })
      const found: Range[] = []
      for (let node = walker.nextNode(); node && found.length < 5000; node = walker.nextNode()) {
        const text = node.nodeValue!
        re.lastIndex = 0
        for (let m = re.exec(text); m && found.length < 5000; m = re.exec(text)) {
          if (!m[0]) {
            re.lastIndex++
            continue
          }
          const r = document.createRange()
          r.setStart(node, m.index)
          r.setEnd(node, m.index + m[0].length)
          found.push(r)
        }
      }
      ranges.current = found
      setCount(found.length)
      if (found.length) CSS.highlights?.set('mf-find', new Highlight(...found))
      const next = keepIndex ? Math.min(index, found.length - 1) : 0
      setIndex(Math.max(0, next))
      reveal(Math.max(0, next), 260)
    },
    [query, opts, index, reveal]
  )

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    } else {
      clear()
      clearTimeout(pulseTimer.current)
    }
  }, [open])

  useEffect(() => {
    if (open) search()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, open])

  // ⌘E / ⌘G in reading mode seed the query with the selected text.
  useEffect(() => {
    if (!open || !seed) return
    setState({ findSeed: null })
    if (seed.text) setQuery(seed.text)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [open, seed])

  useEffect(() => {
    if (!open) return
    const onRendered = () => search(true)
    window.addEventListener('mf-preview-rendered', onRendered)
    return () => window.removeEventListener('mf-preview-rendered', onRendered)
  }, [open, search])

  const step = (d: number) => {
    if (!count) return
    const next = (index + d + count) % count
    setIndex(next)
    reveal(next)
  }
  const stepRef = useRef(step)
  stepRef.current = step

  // ⌘G / ⇧⌘G and ⌥⌘R / ⌥⌘C / ⌥⌘W from the menu or shortcut dispatcher.
  useEffect(() => {
    if (!open) return
    const onStep = (e: Event) => stepRef.current((e as CustomEvent<number>).detail)
    const onToggle = (e: Event) => {
      const key = (e as CustomEvent<keyof FindOptions>).detail
      setOpts((o) => ({ ...o, [key]: !o[key] }))
    }
    window.addEventListener('mf-findbar-step', onStep)
    window.addEventListener('mf-findbar-toggle', onToggle)
    return () => {
      window.removeEventListener('mf-findbar-step', onStep)
      window.removeEventListener('mf-findbar-toggle', onToggle)
    }
  }, [open])

  if (!open) return null
  const toggle = (k: keyof FindOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }))
  return (
    <div className="findbar find-widget" onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
      <div className="find-rows">
        <div className="find-row">
          <div className={`find-input-wrap${invalid ? ' invalid' : query && !count ? ' no-results' : ''}`}>
            <input
              ref={inputRef}
              className="find-input"
              value={query}
              placeholder={t('find.placeholder')}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
                else if (e.key === 'Escape') setState({ findOpen: false })
              }}
            />
            <span className="find-count">
              {invalid ? t('find.invalid') : query ? (count ? t('find.count', { i: index + 1, n: count }) : t('find.noResults')) : ''}
            </span>
            <button className={`find-opt${opts.caseSensitive ? ' on' : ''}`} title={t('search.caseSensitive')} onClick={() => toggle('caseSensitive')}>
              <CaseSensitive size={15} />
            </button>
            <button className={`find-opt${opts.wholeWord ? ' on' : ''}`} title={t('search.wholeWord')} onClick={() => toggle('wholeWord')}>
              <WholeWord size={15} />
            </button>
            <button className={`find-opt${opts.regexp ? ' on' : ''}`} title={t('search.regex')} onClick={() => toggle('regexp')}>
              <Regex size={15} />
            </button>
          </div>
          <button className="find-btn" title={t('cmd.findPrev')} onClick={() => step(-1)}>
            <ArrowUp size={15} />
          </button>
          <button className="find-btn" title={t('cmd.findNext')} onClick={() => step(1)}>
            <ArrowDown size={15} />
          </button>
          <button className="find-btn" title={t('find.close')} onClick={() => setState({ findOpen: false })}>
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
