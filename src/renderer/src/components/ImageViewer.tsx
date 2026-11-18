import { useState } from 'react'
import { activeTab, useStore } from '@/store'

export function ImageViewer() {
  const tab = useStore((s) => activeTab(s))
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [fit, setFit] = useState(true)
  if (!tab?.path || tab.kind !== 'image') return null
  const src = window.mf.toAssetUrl(tab.path) + `?v=${tab.mtime}`
  return (
    <div className={`image-viewer${fit ? ' fit' : ''}`} onClick={() => setFit((f) => !f)}>
      <img
        src={src}
        alt={tab.name}
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
      {size && (
        <div className="image-meta">
          {size.w} × {size.h}
        </div>
      )}
    </div>
  )
}
