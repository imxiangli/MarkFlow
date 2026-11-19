import { RefreshCw } from 'lucide-react'
import type { UpdateState } from '@shared/update'
import { updateSettings } from '@/actions'
import { useT, type TFunction } from '@/lib/i18n'
import { useStore } from '@/store'

export function formatBytes(n: number | undefined): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function updatePercent(u: UpdateState): number {
  return u.total ? Math.min(100, Math.round(((u.downloaded ?? 0) / u.total) * 100)) : 0
}

/** One-line description of the updater state. */
export function describeUpdate(u: UpdateState, t: TFunction): string {
  switch (u.status) {
    case 'disabled':
      return u.disabledReason === 'dev' ? t('update.devDisabled') : t('update.noUrl')
    case 'checking':
      return t('update.checking')
    case 'up-to-date':
      return t('update.upToDate')
    case 'available':
      return t('update.available', { version: u.latestVersion ?? '' })
    case 'downloading':
    case 'full-downloading':
      return t('update.downloading', { percent: updatePercent(u) })
    case 'ready':
      return t('update.ready', { version: u.latestVersion ?? '' })
    case 'full-available':
      return t('update.fullAvailable', { version: u.latestVersion ?? '' })
    case 'full-ready':
      return u.autoInstall
        ? t('update.fullReadyAuto', { version: u.latestVersion ?? '' })
        : t('update.fullReady', { path: u.installerPath ?? '' })
    case 'error':
      return t('update.error', { msg: u.error ?? '' })
    default:
      return ''
  }
}

function Toggle({ k, label }: { k: 'autoCheckUpdates' | 'autoDownloadUpdates'; label: string }) {
  const value = useStore((s) => s.settings[k])
  return (
    <label className="setting-row check">
      <input type="checkbox" checked={value} onChange={(e) => void updateSettings({ [k]: e.target.checked })} />
      <span>{label}</span>
    </label>
  )
}

export function UpdatePanel() {
  const t = useT()
  const u = useStore((s) => s.update)
  const updateUrl = useStore((s) => s.settings.updateUrl)
  if (!u) return null
  const busy = u.status === 'checking' || u.status === 'downloading' || u.status === 'full-downloading'
  const showDelta = (u.status === 'downloading' || u.status === 'ready') && u.filesTotal

  return (
    <>
      <h3>{t('settings.update')}</h3>
      <div className="update-card">
        <div className="update-version">
          <span className="setting-label">{t('update.current')}</span>
          <strong>v{u.currentVersion}</strong>
          {u.hot && <span className="update-badge">{t('update.hotFrom', { base: u.baseVersion })}</span>}
        </div>
        <p className={`update-status ${u.status}`}>{describeUpdate(u, t)}</p>
        {(u.status === 'downloading' || u.status === 'full-downloading') && (
          <div className="update-progress">
            <div style={{ width: `${updatePercent(u)}%` }} />
          </div>
        )}
        {showDelta ? (
          <p className="setting-desc">
            {t('update.deltaInfo', { files: u.filesToDownload ?? 0, total: u.filesTotal ?? 0, size: formatBytes(u.total) })}{' '}
            {u.fullSize ? t('update.fullCompare', { size: formatBytes(u.fullSize) }) : ''}
          </p>
        ) : null}
        {u.notes && (u.status === 'available' || u.status === 'ready' || u.status === 'full-available') && (
          <details className="update-notes" open>
            <summary>{t('update.notes')}</summary>
            <pre>{u.notes}</pre>
          </details>
        )}
        <div className="update-actions">
          <button className="btn" disabled={busy || u.status === 'disabled'} onClick={() => void window.mf.checkForUpdates()}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} /> {t('update.check')}
          </button>
          {u.status === 'available' && (
            <button className="btn primary" onClick={() => void window.mf.downloadUpdate()}>
              {t('update.download')}
            </button>
          )}
          {u.status === 'full-available' && (
            <button className="btn primary" onClick={() => void window.mf.downloadUpdate()}>
              {t('update.fullDownload')}
              {u.fullSize ? ` (${formatBytes(u.fullSize)})` : ''}
            </button>
          )}
          {u.status === 'ready' && (
            <button className="btn primary" onClick={() => void window.mf.installUpdate()}>
              {t('update.restart')}
            </button>
          )}
          {u.status === 'full-ready' && (
            <button className="btn primary" onClick={() => void window.mf.installUpdate()}>
              {u.autoInstall ? t('update.installRestart') : t('update.openInstaller')}
            </button>
          )}
        </div>
        {u.lastChecked ? (
          <p className="setting-desc small">{t('update.lastChecked', { time: new Date(u.lastChecked).toLocaleString() })}</p>
        ) : null}
      </div>
      <Toggle k="autoCheckUpdates" label={t('update.autoCheck')} />
      <Toggle k="autoDownloadUpdates" label={t('update.autoDownload')} />
      <label className="setting-row">
        <span className="setting-label">{t('update.server')}</span>
        <span className="setting-control">
          <input
            type="text"
            defaultValue={updateUrl}
            key={updateUrl}
            placeholder={t('update.serverPlaceholder', { source: u.source ?? 'GitHub Releases' })}
            spellCheck={false}
            onBlur={(e) => e.target.value.trim() !== updateUrl && void updateSettings({ updateUrl: e.target.value.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </span>
      </label>
      <p className="setting-desc small">{t('update.serverHint')}</p>
    </>
  )
}
