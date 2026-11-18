import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/markdown.css'
import { App } from './App'
import {
  activate,
  applySettings,
  handleBeforeClose,
  handleFileChanged,
  openFile,
  openFolder,
  openPaths,
  restoreBackups,
  runMenuCommand,
  startPersistence
} from './actions'
import { startBackups } from './lib/backup'
import { installShortcuts } from './lib/shortcuts'
import { startTheme } from './lib/theme'
import { configureScrollSync } from './lib/scrollSync'
import { getState, setState } from './store'
import { samePath } from './lib/path'

async function bootstrap(): Promise<void> {
  const api = window.mf
  const init = await api.getInitialState()
  setState({
    platform: init.platform,
    version: init.version,
    homeDir: init.homeDir,
    isPackaged: init.isPackaged,
    systemLocale: init.locale,
    recent: init.recent,
    viewMode: init.settings.viewMode,
    lastEditMode: init.settings.viewMode === 'edit' ? 'edit' : 'split'
  })
  applySettings(init.settings)
  document.documentElement.lang = getState().locale
  startTheme()
  configureScrollSync(() => {
    const s = getState()
    return s.settings.syncScroll && s.viewMode === 'split'
  })

  api.onSettingsChanged((settings) => {
    applySettings(settings)
    document.documentElement.lang = getState().locale
  })
  api.onRecentChanged((recent) => setState({ recent }))
  api.onTreeChanged((tree) => setState({ tree }))
  api.onFileChanged((path, kind) => void handleFileChanged(path, kind))
  api.onMenuCommand((cmd) => runMenuCommand(cmd))
  installShortcuts()
  // Leaving full screen (green button, Esc, ⌃⌘F) also ends focus mode.
  api.onFullScreen((full) => {
    if (!full && getState().focusMode) setState({ focusMode: false })
  })
  api.onOpenPaths((paths) => void openPaths(paths))
  api.onBeforeClose(() => void handleBeforeClose())
  api.onUpdateState((update) => setState({ update }))
  void api.getUpdateState().then((update) => setState({ update }))

  createRoot(document.getElementById('root')!).render(<App />)

  // Restore the previous session (first window only, and only when nothing was passed in).
  const session = init.session
  if (session) {
    if (session.root && (await api.stat(session.root))?.isDirectory) await openFolder(session.root, { quiet: true })
    for (const file of session.files) {
      if ((await api.stat(file))?.isFile) await openFile(file)
    }
    const active = getState().tabs.find((t) => samePath(t.path, session.active))
    if (active) activate(active.id)
  }

  // Bring back unsaved work from a crash / forced quit, then keep backing up from here on.
  const adopted = init.backups.length ? await restoreBackups(init.backups) : new Map()
  startBackups(adopted)

  setState({ ready: true })
  startPersistence()
  api.rendererReady()
}

void bootstrap()
