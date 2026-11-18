import { TriangleAlert } from 'lucide-react'
import { closeTab, keepMine, reloadTab, saveTab } from '@/actions'
import { useT } from '@/lib/i18n'
import { activeTab, updateTab, useStore } from '@/store'

export function Banner() {
  const t = useT()
  const tab = useStore((s) => activeTab(s))
  if (!tab || (!tab.externalChange && !tab.deleted)) return null
  return (
    <div className="banner">
      <TriangleAlert size={15} />
      <span>{tab.deleted ? t('banner.deleted') : t('banner.changed')}</span>
      <span className="banner-spacer" />
      {tab.deleted ? (
        <>
          <button className="btn small" onClick={() => void saveTab(tab.id)}>
            {t('common.save')}
          </button>
          <button className="btn small" onClick={() => void closeTab(tab.id, true)}>
            {t('common.close')}
          </button>
          <button className="btn small" onClick={() => updateTab(tab.id, { deleted: false })}>
            {t('common.keepMine')}
          </button>
        </>
      ) : (
        <>
          <button className="btn small primary" onClick={() => void reloadTab(tab.id)}>
            {t('common.reload')}
          </button>
          <button className="btn small" onClick={() => keepMine(tab.id)}>
            {t('common.keepMine')}
          </button>
        </>
      )}
    </div>
  )
}
