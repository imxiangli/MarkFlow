import { useEffect, useRef } from 'react'
import { openPaths, updateSettings } from '@/actions'
import { useT } from '@/lib/i18n'
import { activeTab, useStore } from '@/store'
import { Banner } from './components/Banner'
import { BinaryViewer, LargeFileLoading } from './components/BinaryViewer'
import { ContextMenuHost } from './components/ContextMenu'
import { EditorPane, EditorToolbar } from './components/EditorPane'
import { FindBar } from './components/FindBar'
import { ImageViewer } from './components/ImageViewer'
import { AboutDialog, Toasts } from './components/Overlays'
import { ZoomViewer } from './components/ZoomViewer'
import { Preview } from './components/Preview'
import { Palette } from './components/Palette'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Welcome } from './components/Welcome'

/** Drag handle that reports a new size while dragging and commits on release. */
function useDrag(onMove: (dx: number, start: number) => void, onEnd: () => void, getStart: () => number) {
  return (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const start = getStart()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => onMove(ev.clientX - startX, start)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      onEnd()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
}

function Workspace() {
  const tab = useStore((s) => activeTab(s))
  const viewMode = useStore((s) => s.viewMode)
  const splitRatio = useStore((s) => s.settings.splitRatio)
  const findOpen = useStore((s) => s.findOpen)
  const panesRef = useRef<HTMLDivElement>(null)
  const ratio = useRef(splitRatio)
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ratio.current = splitRatio
  }, [splitRatio])

  const kind = tab?.kind
  const mode = !tab
    ? 'none'
    : kind === 'image' || kind === 'binary'
      ? kind
      : tab.loading !== undefined
        ? 'loading'
        : kind === 'text' || tab.large
          ? 'edit'
          : viewMode
  const showEditor = mode === 'edit' || mode === 'split'
  const showPreview = mode === 'preview' || mode === 'split'

  const onSplitDrag = useDrag(
    (dx, start) => {
      const w = panesRef.current?.clientWidth ?? 1
      const next = Math.min(0.8, Math.max(0.2, start + dx / w))
      ratio.current = next
      if (editorRef.current) editorRef.current.style.flexBasis = `${next * 100}%`
    },
    () => void updateSettings({ splitRatio: ratio.current }),
    () => ratio.current
  )

  return (
    <div className="workspace">
      <Banner />
      {showEditor && kind === 'markdown' && <EditorToolbar />}
      <div className={`panes mode-${mode}`} ref={panesRef}>
        <div
          className="pane pane-editor"
          ref={editorRef}
          style={{ display: showEditor ? undefined : 'none', flexBasis: mode === 'split' ? `${splitRatio * 100}%` : undefined }}
        >
          <EditorPane visible={showEditor} />
        </div>
        {mode === 'split' && <div className="splitter" onPointerDown={onSplitDrag} />}
        <div className="pane pane-preview" style={{ display: showPreview ? undefined : 'none' }}>
          <Preview visible={showPreview} />
          {findOpen && showPreview && <FindBar />}
        </div>
        {mode === 'image' && <ImageViewer />}
        {mode === 'binary' && <BinaryViewer />}
        {mode === 'loading' && <LargeFileLoading />}
      </div>
      {!tab && <Welcome />}
    </div>
  )
}

export function App() {
  const platform = useStore((s) => s.platform)
  const t = useT()
  const sidebarVisible = useStore((s) => s.sidebarVisible && !s.focusMode)
  const focusMode = useStore((s) => s.focusMode)
  const chordPending = useStore((s) => s.chordPending)
  const sidebarWidth = useStore((s) => s.settings.sidebarWidth)
  const width = useRef(sidebarWidth)
  const sidebarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    width.current = sidebarWidth
  }, [sidebarWidth])

  useEffect(() => {
    // Opening files/folders by dropping them anywhere on the window.
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      const paths = [...e.dataTransfer.files].map((f) => window.mf.getPathForFile(f)).filter(Boolean)
      if (paths.length) void openPaths(paths)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const onSidebarDrag = useDrag(
    (dx, start) => {
      const next = Math.min(520, Math.max(180, start + dx))
      width.current = next
      if (sidebarRef.current) sidebarRef.current.style.width = `${next}px`
    },
    () => void updateSettings({ sidebarWidth: Math.round(width.current) }),
    () => width.current
  )

  return (
    <div className={`app platform-${platform}${focusMode ? ' focus-mode' : ''}`}>
      <TitleBar />
      <div className="main">
        {sidebarVisible && (
          <>
            <div className="sidebar-wrap" ref={sidebarRef} style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
            <div className="sidebar-resizer" onPointerDown={onSidebarDrag} onDoubleClick={() => void updateSettings({ sidebarWidth: 260 })} />
          </>
        )}
        <Workspace />
      </div>
      <StatusBar />
      {chordPending && <div className="chord-hint">{t('status.chordPending', { key: chordPending })}</div>}
      <Palette />
      <SettingsDialog />
      <AboutDialog />
      <ZoomViewer />
      <Toasts />
      <ContextMenuHost />
    </div>
  )
}
