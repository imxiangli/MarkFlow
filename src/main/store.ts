import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type RecentItem, type SessionState, type Settings } from '@shared/types'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface StoreData {
  settings: Settings
  recent: RecentItem[]
  session: SessionState | null
  windowState: WindowState
}

const MAX_RECENT = 20

class Store {
  private data: StoreData
  private file: string
  private timer: NodeJS.Timeout | null = null

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'markflow-config.json')
    this.data = this.load()
  }

  private load(): StoreData {
    const fallback: StoreData = {
      settings: { ...DEFAULT_SETTINGS },
      recent: [],
      session: null,
      windowState: { width: 1280, height: 820, maximized: false }
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
      return {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        recent: Array.isArray(raw.recent) ? raw.recent.slice(0, MAX_RECENT) : [],
        session: raw.session ?? null,
        windowState: { ...fallback.windowState, ...(raw.windowState ?? {}) }
      }
    } catch {
      return fallback
    }
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] failed to save', err)
    }
  }

  get settings(): Settings {
    return this.data.settings
  }

  setSettings(partial: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...partial }
    this.scheduleSave()
    return this.data.settings
  }

  get recent(): RecentItem[] {
    return this.data.recent
  }

  addRecent(path: string, kind: 'file' | 'folder'): RecentItem[] {
    this.data.recent = [{ path, kind, time: Date.now() }, ...this.data.recent.filter((r) => r.path !== path)].slice(
      0,
      MAX_RECENT
    )
    this.scheduleSave()
    return this.data.recent
  }

  clearRecent(): RecentItem[] {
    this.data.recent = []
    this.scheduleSave()
    return this.data.recent
  }

  get session(): SessionState | null {
    return this.data.session
  }

  setSession(session: SessionState): void {
    this.data.session = session
    this.scheduleSave()
  }

  get windowState(): WindowState {
    return this.data.windowState
  }

  setWindowState(state: WindowState): void {
    this.data.windowState = state
    this.scheduleSave()
  }
}

let instance: Store | null = null

export function getStore(): Store {
  if (!instance) instance = new Store()
  return instance
}
