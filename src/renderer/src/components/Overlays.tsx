import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { setState, useStore } from '@/store'
import { Logo } from './Logo'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`}>
          {x.message}
        </div>
      ))}
    </div>
  )
}

export function AboutDialog() {
  const t = useT()
  const open = useStore((s) => s.aboutOpen)
  const version = useStore((s) => s.version)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setState({ aboutOpen: false })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={() => setState({ aboutOpen: false })}>
      <div className="modal about" onMouseDown={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={() => setState({ aboutOpen: false })}>
          <X size={16} />
        </button>
        <Logo size={72} />
        <h2>MarkFlow</h2>
        <p className="about-version">v{version}</p>
        <p>{t('app.tagline')}</p>
        <p className="about-small">CommonMark · GFM · KaTeX · Mermaid · Graphviz · ECharts · PlantUML</p>
      </div>
    </div>
  )
}
