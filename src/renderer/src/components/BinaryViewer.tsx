import { useEffect, useState } from 'react'
import { closeTab, openAsText } from '@/actions'
import { useT } from '@/lib/i18n'
import { fileCategory, formatSize } from '@/lib/fileTypes'
import { activeTab, useStore } from '@/store'
import { extOf, isBinaryFile } from '@shared/constants'
import { FileIcon } from './FileIcon'

/** Files MarkFlow can't show: the system's file-type icon in the middle, plus a few actions. */
export function BinaryViewer() {
  const t = useT()
  const tab = useStore((s) => activeTab(s))
  const platform = useStore((s) => s.platform)
  const locale = useStore((s) => s.locale)
  const [icon, setIcon] = useState<{ path: string; url: string | null } | null>(null)
  const path = tab?.kind === 'binary' ? tab.path : null

  useEffect(() => {
    if (!path) return
    let alive = true
    void window.mf.fileIcon(path).then((url) => alive && setIcon({ path, url }))
    return () => {
      alive = false
    }
  }, [path])

  if (!tab || !path) return null
  const ext = extOf(tab.name)
  const category = fileCategory(tab.name)
  const type = [ext ? t('binary.file', { ext: ext.toUpperCase() }) : t('binary.noExt')]
  if (category !== 'text' && category !== 'code' && category !== 'json' && category !== 'shell' && category !== 'markdown') {
    type.push(t(`binary.cat.${category === 'spreadsheet' ? 'document' : category}` as 'binary.cat.data'))
  }
  const modified = tab.mtime ? new Date(tab.mtime).toLocaleString(locale) : ''
  const systemIcon = icon?.path === path ? icon.url : null

  return (
    <div className="binary-viewer">
      <div className="binary-card">
        <div className="binary-icon">
          {systemIcon ? <img src={systemIcon} alt="" draggable={false} /> : <FileIcon name={tab.name} size={88} strokeWidth={1.1} />}
        </div>
        <div className="binary-name" title={path}>
          {tab.name}
        </div>
        <div className="binary-meta">
          {[type.join(' · '), formatSize(tab.size), modified && t('binary.modified', { time: modified })].filter(Boolean).join('  ·  ')}
        </div>
        <p className="binary-note">{tab.tooLarge ? t('binary.tooLarge') : t('binary.note')}</p>
        <div className="binary-actions">
          <button className="btn primary" onClick={() => void window.mf.openPath(path)}>
            {t('binary.openDefault')}
          </button>
          <button className="btn" onClick={() => window.mf.showItemInFolder(path)}>
            {t(`ctx.reveal.${platform}` as 'ctx.reveal.darwin')}
          </button>
          {/* Content sniffing can be wrong for odd text files; known formats (zip, mp4…) can't be text. */}
          {!tab.tooLarge && !isBinaryFile(tab.name) && (
            <button className="btn" onClick={() => void openAsText(tab.id)}>
              {t('binary.openAsText')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Progress while a large file streams into the editor; cancelling closes the tab. */
export function LargeFileLoading() {
  const t = useT()
  const tab = useStore((s) => activeTab(s))
  if (!tab || tab.loading === undefined) return null
  const percent = Math.round(tab.loading * 100)
  return (
    <div className="binary-viewer">
      <div className="binary-card">
        <div className="binary-icon">
          <FileIcon name={tab.name} size={72} strokeWidth={1.1} />
        </div>
        <div className="binary-name">{tab.name}</div>
        <div className="binary-meta">
          {t('large.loading', { percent })}
          {tab.size ? `  ·  ${formatSize(tab.size * tab.loading)} / ${formatSize(tab.size)}` : ''}
        </div>
        <div className="large-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${percent}%` }} />
        </div>
        <div className="binary-actions">
          <button className="btn" onClick={() => void closeTab(tab.id, true)}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
