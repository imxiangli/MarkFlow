import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { Settings } from '@shared/types'
import { setDefaultApp, updateSettings } from '@/actions'
import { useT } from '@/lib/i18n'
import { setState, useStore } from '@/store'
import { UpdatePanel } from './UpdatePanel'

type Section = 'general' | 'editor' | 'preview' | 'files' | 'update' | 'advanced'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="setting-row">
      <span className="setting-label">{label}</span>
      <span className="setting-control">{children}</span>
    </label>
  )
}

function Toggle({ k, label }: { k: keyof Settings; label: string }) {
  const value = useStore((s) => s.settings[k]) as boolean
  return (
    <label className="setting-row check">
      <input type="checkbox" checked={value} onChange={(e) => void updateSettings({ [k]: e.target.checked })} />
      <span>{label}</span>
    </label>
  )
}

function TextInput({ k, placeholder }: { k: keyof Settings; placeholder?: string }) {
  const value = useStore((s) => s.settings[k]) as string
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && void updateSettings({ [k]: draft })}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumberInput({ k, min, max }: { k: keyof Settings; min: number; max: number }) {
  const value = useStore((s) => s.settings[k]) as number
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n) && n >= min && n <= max) void updateSettings({ [k]: n })
      }}
    />
  )
}

function Select<K extends keyof Settings>({ k, options }: { k: K; options: { value: Settings[K]; label: string }[] }) {
  const value = useStore((s) => s.settings[k])
  return (
    <select value={String(value)} onChange={(e) => void updateSettings({ [k]: e.target.value } as Partial<Settings>)}>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function SettingsDialog() {
  const t = useT()
  const open = useStore((s) => s.settingsOpen)
  const isPackaged = useStore((s) => s.isPackaged)
  const requested = useStore((s) => s.settingsSection) as Section | null
  const [section, setSection] = useState<Section>('general')

  useEffect(() => {
    if (open && requested) {
      setSection(requested)
      setState({ settingsSection: null })
    }
  }, [open, requested])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setState({ settingsOpen: false })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const close = () => setState({ settingsOpen: false })
  const sections: { id: Section; label: string }[] = [
    { id: 'general', label: t('settings.general') },
    { id: 'editor', label: t('settings.editor') },
    { id: 'preview', label: t('settings.preview') },
    { id: 'files', label: t('settings.files') },
    { id: 'update', label: t('settings.update') },
    { id: 'advanced', label: t('settings.advanced') }
  ]

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <h2>{t('settings.title')}</h2>
          {sections.map((s) => (
            <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          <button className="modal-close" onClick={close}>
            <X size={16} />
          </button>
          {section === 'general' && (
            <>
              <h3>{t('settings.general')}</h3>
              <Row label={t('settings.language')}>
                <Select
                  k="language"
                  options={[
                    { value: 'auto', label: t('settings.language.auto') },
                    { value: 'zh-CN', label: '简体中文' },
                    { value: 'en', label: 'English' }
                  ]}
                />
              </Row>
              <Row label={t('settings.theme')}>
                <Select
                  k="theme"
                  options={[
                    { value: 'system', label: t('menu.themeSystem') },
                    { value: 'light', label: t('menu.themeLight') },
                    { value: 'dark', label: t('menu.themeDark') }
                  ]}
                />
              </Row>
              <Row label={t('settings.viewMode')}>
                <Select
                  k="viewMode"
                  options={[
                    { value: 'preview', label: t('view.preview') },
                    { value: 'edit', label: t('view.edit') },
                    { value: 'split', label: t('view.split') }
                  ]}
                />
              </Row>
              <Toggle k="restoreSession" label={t('settings.restoreSession')} />
              <Toggle k="openParentFolder" label={t('settings.openParentFolder')} />
              <h3>{t('settings.fileAssociation')}</h3>
              <p className="setting-desc">{t('settings.fileAssociationDesc')}</p>
              <button className="btn" disabled={!isPackaged} onClick={() => void setDefaultApp()}>
                {t('settings.setDefault')}
              </button>
              {!isPackaged && <p className="setting-desc">{t('settings.setDefaultDev')}</p>}
            </>
          )}
          {section === 'editor' && (
            <>
              <h3>{t('settings.editor')}</h3>
              <Row label={t('settings.editorFontSize')}>
                <NumberInput k="editorFontSize" min={10} max={32} />
              </Row>
              <Row label={t('settings.editorFontFamily')}>
                <TextInput k="editorFontFamily" placeholder={t('settings.fontPlaceholder')} />
              </Row>
              <Toggle k="lineNumbers" label={t('settings.lineNumbers')} />
              <Toggle k="lineWrapping" label={t('settings.lineWrapping')} />
              <Toggle k="autoSave" label={t('settings.autoSave')} />
              <Toggle k="syncScroll" label={t('settings.syncScroll')} />
            </>
          )}
          {section === 'preview' && (
            <>
              <h3>{t('settings.preview')}</h3>
              <Row label={t('settings.previewFontSize')}>
                <NumberInput k="previewFontSize" min={11} max={32} />
              </Row>
              <Row label={t('settings.previewFontFamily')}>
                <TextInput k="previewFontFamily" placeholder={t('settings.fontPlaceholder')} />
              </Row>
              <Toggle k="dblclickToEdit" label={t('settings.dblclickToEdit')} />
              <Row label={t('settings.previewWidth')}>
                <Select
                  k="previewWidth"
                  options={[
                    { value: 'narrow', label: t('settings.width.narrow') },
                    { value: 'medium', label: t('settings.width.medium') },
                    { value: 'wide', label: t('settings.width.wide') },
                    { value: 'full', label: t('settings.width.full') }
                  ]}
                />
              </Row>
            </>
          )}
          {section === 'files' && (
            <>
              <h3>{t('settings.files')}</h3>
              <Toggle k="showAllFiles" label={t('settings.showAllFiles')} />
              <Toggle k="showHiddenFiles" label={t('settings.showHiddenFiles')} />
              <Row label={t('settings.imageFolder')}>
                <TextInput k="imageFolder" placeholder="assets" />
              </Row>
            </>
          )}
          {section === 'update' && <UpdatePanel />}
          {section === 'advanced' && (
            <>
              <h3>{t('settings.advanced')}</h3>
              <Toggle k="enablePlantUML" label={t('settings.enablePlantUML')} />
              <Row label={t('settings.plantumlServer')}>
                <TextInput k="plantumlServer" />
              </Row>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
