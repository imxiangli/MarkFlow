import { useEffect, useRef } from 'react'
import { requestReveal } from '@/actions'
import { useT } from '@/lib/i18n'
import { activeTab, useStore } from '@/store'

export function Outline() {
  const t = useT()
  const headings = useStore((s) => s.headings)
  const activeHeading = useStore((s) => s.activeHeading)
  const activeId = useStore((s) => s.activeId)
  const large = useStore((s) => !!activeTab(s)?.large)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector('.outline-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [activeHeading])

  if (large) return <div className="sidebar-empty">{t('large.noHeadings')}</div>
  if (!headings.length) return <div className="sidebar-empty">{t('sidebar.noOutline')}</div>
  const min = Math.min(...headings.map((h) => h.level))
  return (
    <div className="outline" ref={listRef}>
      {headings.map((h, i) => (
        <div
          key={`${h.id}-${i}`}
          className={`outline-item level-${h.level}${activeHeading === h.id ? ' active' : ''}`}
          style={{ paddingLeft: 12 + (h.level - min) * 14 }}
          title={h.text}
          onClick={() => activeId && requestReveal(activeId, { anchor: h.id, line: h.line })}
        >
          {h.text || '—'}
        </div>
      ))}
    </div>
  )
}
