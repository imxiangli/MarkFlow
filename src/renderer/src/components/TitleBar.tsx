import { useRef, useState } from 'react'
import { Columns2, Eye, PanelLeft, PenLine, Plus, Settings, X } from 'lucide-react'
import { activate, closeTab, closeTabs, newFile, setViewMode, toggleSidebar } from '@/actions'
import { useT } from '@/lib/i18n'
import { relative } from '@/lib/path'
import { activeTab, getState, isDirty, isNewDocument, setState, useStore, type Tab } from '@/store'
import { openContextMenu } from './ContextMenu'
import { FileIcon } from './FileIcon'

function TabItem({ tab, active, onDragStart, onDrop }: { tab: Tab; active: boolean; onDragStart: () => void; onDrop: () => void }) {
  const t = useT()
  const dirty = isDirty(tab) && !tab.builtin
  const platform = useStore((s) => s.platform)
  const [over, setOver] = useState(false)
  const root = useStore((s) => s.root)

  const menu = (e: React.MouseEvent) => {
    const tabs = getState().tabs
    const idx = tabs.findIndex((x) => x.id === tab.id)
    openContextMenu(e, [
      { label: t('ctx.close'), onClick: () => void closeTab(tab.id) },
      { label: t('ctx.closeOthers'), onClick: () => void closeTabs(tabs.filter((x) => x.id !== tab.id).map((x) => x.id)) },
      { label: t('ctx.closeRight'), onClick: () => void closeTabs(tabs.slice(idx + 1).map((x) => x.id)) },
      { label: t('ctx.closeAll'), onClick: () => void closeTabs(tabs.map((x) => x.id)) },
      { separator: true },
      ...(isNewDocument(tab)
        ? [
            {
              label: t('ctx.setType'),
              onClick: () => {
                activate(tab.id)
                setState({ palette: `>${t('cmd.setType', { name: '' })}` })
              }
            }
          ]
        : []),
      { label: t('ctx.copyPath'), disabled: !tab.path, onClick: () => tab.path && window.mf.copyText(tab.path) },
      {
        label: t(platform === 'darwin' ? 'ctx.reveal.darwin' : platform === 'win32' ? 'ctx.reveal.win32' : 'ctx.reveal.linux'),
        disabled: !tab.path,
        onClick: () => tab.path && window.mf.showItemInFolder(tab.path)
      }
    ])
  }

  return (
    <div
      className={`tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}${over ? ' drop-target' : ''}${tab.deleted ? ' deleted' : ''}`}
      title={tab.path ? (root ? relative(root, tab.path) : tab.path) : tab.name}
      onMouseDown={(e) => {
        if (e.button === 0) activate(tab.id)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id)
      }}
      onContextMenu={menu}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('application/x-markflow-tab', tab.id)
        onDragStart()
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-markflow-tab')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (e.dataTransfer.types.includes('application/x-markflow-tab')) {
          e.preventDefault()
          onDrop()
        }
      }}
    >
      <span className="tab-icon">
        <FileIcon name={tab.name} size={14} />
      </span>
      <span className="tab-name">{tab.name}</span>
      <button
        className="tab-close"
        title={dirty ? t('tabs.dirty') : t('ctx.close')}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void closeTab(tab.id)
        }}
      >
        <span className="tab-dot" />
        <X size={13} className="tab-x" />
      </button>
    </div>
  )
}

function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const dragId = useRef<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const move = (targetId: string) => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const list = [...getState().tabs]
    const a = list.findIndex((x) => x.id === from)
    const b = list.findIndex((x) => x.id === targetId)
    const [item] = list.splice(a, 1)
    list.splice(b, 0, item)
    setState({ tabs: list })
  }

  return (
    <div
      className="tabbar"
      ref={ref}
      onWheel={(e) => {
        if (ref.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) ref.current.scrollLeft += e.deltaY
      }}
      onDoubleClick={(e) => {
        if (e.target === ref.current) newFile()
      }}
    >
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onDragStart={() => (dragId.current = tab.id)}
          onDrop={() => move(tab.id)}
        />
      ))}
      <button className="tab-new" onClick={() => newFile()} title="New">
        <Plus size={15} />
      </button>
    </div>
  )
}

function ViewSwitch() {
  const t = useT()
  const mode = useStore((s) => s.viewMode)
  const kind = useStore((s) => activeTab(s)?.kind)
  const disabled = !kind || kind !== 'markdown'
  const items = [
    { id: 'preview' as const, icon: <Eye size={15} />, label: t('view.preview') },
    { id: 'edit' as const, icon: <PenLine size={15} />, label: t('view.edit') },
    { id: 'split' as const, icon: <Columns2 size={15} />, label: t('view.split') }
  ]
  return (
    <div className={`view-switch${disabled ? ' disabled' : ''}`}>
      {items.map((x) => (
        <button
          key={x.id}
          className={mode === x.id ? 'active' : ''}
          title={x.label}
          disabled={disabled}
          onClick={() => setViewMode(x.id)}
        >
          {x.icon}
          <span>{x.label}</span>
        </button>
      ))}
    </div>
  )
}

export function TitleBar() {
  const t = useT()
  const platform = useStore((s) => s.platform)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  return (
    <header className={`titlebar${platform === 'darwin' ? ' mac' : ''}`}>
      <button
        className={`icon-btn${sidebarVisible ? ' on' : ''}`}
        title={t('view.toggleSidebar')}
        onClick={() => toggleSidebar()}
      >
        <PanelLeft size={16} />
      </button>
      <TabBar />
      <ViewSwitch />
      <button className="icon-btn" title={t('view.settings')} onClick={() => setState({ settingsOpen: true })}>
        <Settings size={16} />
      </button>
    </header>
  )
}
