import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderOpen, FolderPlus, ListTree, RefreshCw, Search, X, Files } from 'lucide-react'
import { closeFolder, openFolder, refreshTree, showOpenFolder, toggleSidebar, updateSettings } from '@/actions'
import { useT } from '@/lib/i18n'
import { basename, dirname } from '@/lib/path'
import { activeTab, setState, useStore, type SidebarPanel } from '@/store'
import { FileTree, startCreate } from './FileTree'
import { Outline } from './Outline'
import { SearchPanel } from './SearchPanel'

export function Sidebar() {
  const t = useT()
  const panel = useStore((s) => s.sidebarPanel)
  const root = useStore((s) => s.root)
  const activePath = useStore((s) => activeTab(s)?.path ?? null)
  const showAllFiles = useStore((s) => s.settings.showAllFiles)

  const tabs: { id: SidebarPanel; icon: React.ReactNode; label: string }[] = [
    { id: 'files', icon: <Files size={16} />, label: t('sidebar.files') },
    { id: 'outline', icon: <ListTree size={16} />, label: t('sidebar.outline') },
    { id: 'search', icon: <Search size={16} />, label: t('sidebar.search') }
  ]

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        {tabs.map((x) => (
          <button
            key={x.id}
            className={`sidebar-tab${panel === x.id ? ' active' : ''}`}
            title={x.label}
            onClick={() => (x.id === 'search' ? toggleSidebar('search') : setState({ sidebarPanel: x.id }))}
          >
            {x.icon}
            <span>{x.label}</span>
          </button>
        ))}
      </div>

      {panel === 'files' && (
        <>
          {root ? (
            <div className="sidebar-header">
              <span className="sidebar-title" title={root}>
                {basename(root) || root}
              </span>
              <div className="sidebar-actions">
                <button title={t('sidebar.newFile')} onClick={() => startCreate(root, 'file')}>
                  <FilePlus size={15} />
                </button>
                <button title={t('sidebar.newFolder')} onClick={() => startCreate(root, 'dir')}>
                  <FolderPlus size={15} />
                </button>
                <button
                  className={showAllFiles ? 'on' : ''}
                  title={t(showAllFiles ? 'sidebar.markdownOnly' : 'sidebar.showAllFiles')}
                  onClick={() => void updateSettings({ showAllFiles: !showAllFiles })}
                >
                  {showAllFiles ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
                <button title={t('sidebar.refresh')} onClick={() => void refreshTree()}>
                  <RefreshCw size={14} />
                </button>
                <button title={t('sidebar.collapseAll')} onClick={() => setState({ expanded: { [root]: true } })}>
                  <ChevronsDownUp size={15} />
                </button>
                <button title={t('sidebar.closeFolder')} onClick={() => void closeFolder()}>
                  <X size={15} />
                </button>
              </div>
            </div>
          ) : null}
          <div className="sidebar-body">
            {root ? (
              <FileTree />
            ) : (
              <div className="sidebar-placeholder">
                <p>{t('sidebar.noFolder')}</p>
                <button className="btn primary" onClick={() => void showOpenFolder()}>
                  <FolderOpen size={15} /> {t('sidebar.openFolder')}
                </button>
                {activePath && (
                  <button className="btn" onClick={() => void openFolder(dirname(activePath))}>
                    {t('sidebar.openParent')}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {panel === 'outline' && (
        <div className="sidebar-body">
          <Outline />
        </div>
      )}
      {panel === 'search' && (
        <div className="sidebar-body">
          <SearchPanel />
        </div>
      )}
    </aside>
  )
}
