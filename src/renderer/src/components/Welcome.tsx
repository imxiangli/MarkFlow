import { BookOpen, Clock, Command, FilePlus, FileText, Folder, FolderOpen } from 'lucide-react'
import { newFile, openGuide, openPaths, showOpenFile, showOpenFolder } from '@/actions'
import { useT } from '@/lib/i18n'
import { basename, dirname } from '@/lib/path'
import { setState, useStore } from '@/store'
import { displayKey, keyOf } from '@shared/keybindings'
import type { MenuCommand } from '@shared/types'
import { Logo } from './Logo'

export function Welcome() {
  const t = useT()
  const recent = useStore((s) => s.recent)
  const platform = useStore((s) => s.platform)
  const keys = (id: MenuCommand) => displayKey(keyOf(id, platform), platform)
  const actions = [
    { icon: <FilePlus size={18} />, label: t('welcome.newFile'), keys: keys('new-file'), run: newFile },
    { icon: <FileText size={18} />, label: t('welcome.openFile'), keys: keys('open-file'), run: () => void showOpenFile() },
    { icon: <FolderOpen size={18} />, label: t('welcome.openFolder'), keys: keys('open-folder'), run: () => void showOpenFolder() },
    { icon: <Command size={18} />, label: t('cmd.commandPalette'), keys: keys('command-palette'), run: () => setState({ palette: '>' }) },
    { icon: <BookOpen size={18} />, label: t('welcome.guide'), keys: '', run: openGuide }
  ]
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <Logo size={64} />
          <div>
            <h1>MarkFlow</h1>
            <p>{t('app.tagline')}</p>
          </div>
        </div>
        <div className="welcome-cols">
          <section>
            <h2>{t('welcome.start')}</h2>
            {actions.map((a) => (
              <button key={a.label} className="welcome-action" onClick={a.run}>
                {a.icon}
                <span>{a.label}</span>
                {a.keys && <kbd>{a.keys}</kbd>}
              </button>
            ))}
          </section>
          <section>
            <h2>{t('welcome.recent')}</h2>
            {recent.length === 0 && <p className="welcome-muted">{t('welcome.noRecent')}</p>}
            {recent.slice(0, 9).map((r) => (
              <button key={r.path} className="welcome-recent" onClick={() => void openPaths([r.path])} title={r.path}>
                {r.kind === 'folder' ? <Folder size={15} /> : <Clock size={15} />}
                <span className="welcome-recent-name">{basename(r.path) || r.path}</span>
                <span className="welcome-recent-dir">{dirname(r.path)}</span>
              </button>
            ))}
          </section>
        </div>
        <p className="welcome-hint">{t('welcome.dropHint')}</p>
      </div>
    </div>
  )
}
