import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { dirname, join } from '@/lib/path'
import { activeTab, getState, setState, toast, useStore } from '@/store'

interface Transform {
  s: number
  x: number
  y: number
}

const MIN_SCALE = 0.05
const MAX_SCALE = 40

/** Natural size of an SVG from its viewBox / width / height attributes. */
function svgSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.viewBox?.baseVal
  if (vb && vb.width && vb.height) return { w: vb.width, h: vb.height }
  const w = parseFloat(svg.getAttribute('width') ?? '') || svg.getBBox?.().width || 800
  const h = parseFloat(svg.getAttribute('height') ?? '') || svg.getBBox?.().height || 600
  return { w, h }
}

/** Full-window pan & zoom viewer for diagrams (inline SVG) and images. */
export function ZoomViewer() {
  const t = useT()
  const viewer = useStore((s) => s.viewer)
  const stageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const size = useRef({ w: 0, h: 0 })
  const [tf, setTf] = useState<Transform>({ s: 1, x: 0, y: 0 })
  const [ready, setReady] = useState(false)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const close = useCallback(() => setState({ viewer: null }), [])

  const fit = useCallback(() => {
    const stage = stageRef.current
    const { w, h } = size.current
    if (!stage || !w || !h) return
    const sw = stage.clientWidth
    const sh = stage.clientHeight
    const s = Math.min((sw * 0.92) / w, (sh * 0.86) / h, 6)
    setTf({ s, x: (sw - w * s) / 2, y: (sh - h * s) / 2 })
  }, [])

  const actual = useCallback(() => {
    const stage = stageRef.current
    const { w, h } = size.current
    if (!stage) return
    setTf({ s: 1, x: (stage.clientWidth - w) / 2, y: (stage.clientHeight - h) / 2 })
  }, [])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const stage = stageRef.current
    if (!stage) return
    const px = cx ?? stage.clientWidth / 2
    const py = cy ?? stage.clientHeight / 2
    setTf((cur) => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cur.s * factor))
      const k = s / cur.s
      return { s, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k }
    })
  }, [])

  // Measure the content at its natural size, then fit it to the window.
  useLayoutEffect(() => {
    setReady(false)
    if (!viewer || !contentRef.current) return
    const el = contentRef.current
    if (viewer.kind === 'svg') {
      const svg = el.querySelector('svg')
      if (!svg) return
      const { w, h } = svgSize(svg)
      svg.removeAttribute('style')
      svg.setAttribute('width', String(w))
      svg.setAttribute('height', String(h))
      size.current = { w, h }
      fit()
      setReady(true)
    }
  }, [viewer, fit])

  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === '+' || e.key === '=') zoomAt(1.25)
      else if (e.key === '-' || e.key === '_') zoomAt(0.8)
      else if (e.key === '0') fit()
      else if (e.key === '1') actual()
      else if (e.key.startsWith('Arrow')) {
        const d = e.shiftKey ? 200 : 60
        setTf((cur) => ({
          ...cur,
          x: cur.x + (e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0),
          y: cur.y + (e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0)
        }))
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    const onResize = () => fit()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [viewer, close, zoomAt, fit, actual])

  // Wheel / pinch zoom needs a non-passive listener to prevent page scrolling.
  useEffect(() => {
    const stage = stageRef.current
    if (!viewer || !stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      const speed = e.ctrlKey ? 0.01 : 0.0015
      zoomAt(Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [viewer, zoomAt])

  if (!viewer) return null

  const exportSvg = async () => {
    const svg = contentRef.current?.querySelector('svg')
    if (!svg) return
    const s = getState()
    const tab = activeTab(s)
    const dir = tab?.path ? dirname(tab.path) : (s.root ?? s.homeDir)
    const target = await window.mf.showSaveDialog(join(dir, `${viewer.name}.svg`), [{ name: 'SVG', extensions: ['svg'] }])
    if (!target) return
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
    await window.mf.writeFile(target, `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}\n`)
    toast(t('toast.exported', { path: target }), 'success', 4000)
  }

  return (
    <div className="zoom-viewer" role="dialog" aria-modal="true">
      <div
        className={`zoom-stage${drag.current ? ' dragging' : ''}`}
        ref={stageRef}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true
          d.x = e.clientX
          d.y = e.clientY
          setTf((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }))
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          if (tf.s < 1.5) zoomAt(2 / tf.s, e.clientX - r.left, e.clientY - r.top)
          else fit()
        }}
      >
        <div
          className="zoom-content"
          ref={contentRef}
          style={{
            transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})`,
            visibility: ready ? 'visible' : 'hidden'
          }}
        >
          {viewer.kind === 'svg' ? (
            <div className="zoom-svg" dangerouslySetInnerHTML={{ __html: viewer.content }} />
          ) : (
            <img
              src={viewer.content}
              alt=""
              draggable={false}
              onLoad={(e) => {
                size.current = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }
                fit()
                setReady(true)
              }}
            />
          )}
        </div>
      </div>
      <div className="zoom-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button title={t('viewer.zoomOut')} onClick={() => zoomAt(0.8)}>
          <ZoomOut size={16} />
        </button>
        <span className="zoom-level">{Math.round(tf.s * 100)}%</span>
        <button title={t('viewer.zoomIn')} onClick={() => zoomAt(1.25)}>
          <ZoomIn size={16} />
        </button>
        <span className="zoom-sep" />
        <button title={t('viewer.fit')} onClick={fit}>
          <Maximize size={15} />
        </button>
        <button title={t('viewer.actual')} className="zoom-text-btn" onClick={actual}>
          1:1
        </button>
        {viewer.kind === 'svg' && (
          <>
            <span className="zoom-sep" />
            <button title={t('viewer.export')} onClick={() => void exportSvg()}>
              <Download size={15} />
            </button>
          </>
        )}
        <span className="zoom-sep" />
        <button title={t('viewer.close')} onClick={close}>
          <X size={16} />
        </button>
      </div>
      <div className="zoom-hint">{t('viewer.hint')}</div>
    </div>
  )
}
