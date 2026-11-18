import type { BackupEntry } from '@shared/types'
import { hashString } from '@/lib/hash'
import { isEditable, useStore, type Tab } from '@/store'

/**
 * Keeps a crash-safe copy of every unsaved document (see src/main/backups.ts).
 *
 * Each dirty tab gets a random backup id; its content is written ~0.7s after the last edit and
 * the backup is deleted as soon as the tab is saved, reverted or closed without saving.
 */

const WRITE_DELAY = 700

interface Tracked {
  backupId: string
  /** Content / path last written to disk, null while nothing has been written yet. */
  written: string | null
  writtenPath: string | null
  /** Changing a new document's type changes this too, so the backup restores it as that type. */
  writtenLanguage: string | undefined
  timer: number
  /** Serialises writes and deletes for this backup id. */
  chain: Promise<unknown>
}

const tracked = new Map<string, Tracked>()
const pending = new Set<Promise<unknown>>()
let started = false
/**
 * Set once the window is closing after "Don't Save" or "Keep for Next Time": nothing may be
 * written or deleted any more.
 */
let stopped = false

/** Whether this unsaved tab can be kept with "Keep for Next Time" (i.e. it is backed up). */
export function canStash(tab: Tab): boolean {
  return needsBackup(tab)
}

function needsBackup(tab: Tab): boolean {
  // Snapshotting hundreds of MB after every pause in typing would stall the app.
  if (!isEditable(tab) || tab.large) return false
  if (tab.path === null) return tab.content !== '' && tab.content !== tab.saved
  return tab.content !== tab.saved
}

function enqueue(t: Tracked, op: () => Promise<unknown>): void {
  const p = t.chain.then(op).catch((err) => console.warn('[backup]', err))
  t.chain = p
  pending.add(p)
  void p.finally(() => pending.delete(p))
}

function newBackupId(): string {
  return crypto.randomUUID()
}

function write(tabId: string): void {
  const t = tracked.get(tabId)
  const tab = useStore.getState().tabs.find((x) => x.id === tabId)
  if (!t || !tab || !needsBackup(tab)) return
  const entry: BackupEntry = {
    id: t.backupId,
    path: tab.path,
    name: tab.name,
    kind: tab.kind === 'text' ? 'text' : 'markdown',
    language: tab.language,
    content: tab.content,
    encoding: tab.encoding,
    eol: tab.eol,
    savedHash: hashString(tab.saved),
    time: Date.now()
  }
  t.written = tab.content
  t.writtenPath = tab.path
  t.writtenLanguage = tab.language
  enqueue(t, () => window.mf.writeBackup(entry))
}

function schedule(tab: Tab): void {
  let t = tracked.get(tab.id)
  if (!t) {
    t = { backupId: newBackupId(), written: null, writtenPath: null, writtenLanguage: undefined, timer: 0, chain: Promise.resolve() }
    tracked.set(tab.id, t)
  }
  clearTimeout(t.timer)
  t.timer = window.setTimeout(() => write(tab.id), WRITE_DELAY)
}

function remove(tabId: string): void {
  const t = tracked.get(tabId)
  if (!t) return
  clearTimeout(t.timer)
  tracked.delete(tabId)
  if (t.written !== null) enqueue(t, () => window.mf.deleteBackups([t.backupId]))
}

function sync(tabs: Tab[]): void {
  if (stopped) return
  const alive = new Set(tabs.map((x) => x.id))
  for (const id of [...tracked.keys()]) if (!alive.has(id)) remove(id)
  for (const tab of tabs) {
    const t = tracked.get(tab.id)
    if (!needsBackup(tab)) {
      if (t) remove(tab.id)
      continue
    }
    if (!t || t.written !== tab.content || t.writtenPath !== tab.path || t.writtenLanguage !== tab.language) schedule(tab)
  }
}

/**
 * Start tracking. `adopted` maps tabs restored from a crash to the backup they came from, so
 * they keep updating the same file instead of leaving the old one behind.
 */
export function startBackups(adopted: Map<string, { backupId: string; content: string; path: string | null }>): void {
  if (started) return
  started = true
  const tabs = useStore.getState().tabs
  for (const [tabId, a] of adopted) {
    tracked.set(tabId, {
      backupId: a.backupId,
      written: a.content,
      writtenPath: a.path,
      writtenLanguage: tabs.find((x) => x.id === tabId)?.language,
      timer: 0,
      chain: Promise.resolve()
    })
  }
  sync(useStore.getState().tabs)
  useStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) sync(s.tabs)
  })
}

/** Wait until every queued backup write / delete has reached the disk. */
export async function settleBackups(): Promise<void> {
  // Writes that are still debounced are not needed any more once we settle on close.
  while (pending.size) await Promise.allSettled([...pending])
}

/** The user chose "Don't Save" for everything: drop all backups of this window. */
export async function discardBackups(): Promise<void> {
  stopped = true
  for (const id of [...tracked.keys()]) remove(id)
  await settleBackups()
}

/**
 * The user chose "Keep for Next Time": write the latest content of every unsaved tab now
 * (skipping the debounce), stop tracking so closing the window deletes nothing, and hand the
 * backups to the main process so the next window — or the next launch — restores them.
 */
export async function stashBackups(): Promise<void> {
  stopped = true
  const ids: string[] = []
  for (const tab of useStore.getState().tabs) {
    if (!needsBackup(tab)) continue
    let t = tracked.get(tab.id)
    if (!t) {
      t = { backupId: newBackupId(), written: null, writtenPath: null, writtenLanguage: undefined, timer: 0, chain: Promise.resolve() }
      tracked.set(tab.id, t)
    }
    clearTimeout(t.timer)
    if (t.written !== tab.content || t.writtenPath !== tab.path || t.writtenLanguage !== tab.language) write(tab.id)
    ids.push(t.backupId)
  }
  await settleBackups()
  await window.mf.stashBackups(ids)
}
