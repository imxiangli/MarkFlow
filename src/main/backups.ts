import { app } from 'electron'
import { promises as fs, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupEntry } from '@shared/types'

/**
 * Crash-safe copies of unsaved documents ("hot exit"). The renderer writes one JSON file per
 * dirty tab and removes it once the tab is saved or deliberately discarded, so anything left
 * here at startup was lost to a crash, a forced quit or a power cut.
 */

const ID_RE = /^[A-Za-z0-9-]{8,64}$/
const backupsDir = (): string => join(app.getPath('userData'), 'backups')

let startup: BackupEntry[] | null = null

/** Read leftovers once, before any window can start writing new backups. */
export function loadStartupBackups(): void {
  const dir = backupsDir()
  const found: BackupEntry[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    names = []
  }
  for (const name of names) {
    const file = join(dir, name)
    if (name.endsWith('.tmp')) {
      try {
        unlinkSync(file)
      } catch {
        // ignore
      }
      continue
    }
    if (!name.endsWith('.json')) continue
    try {
      const e = JSON.parse(readFileSync(file, 'utf8')) as BackupEntry
      if (ID_RE.test(e.id) && typeof e.content === 'string' && typeof e.name === 'string') found.push(e)
    } catch {
      // A corrupt backup is skipped but kept on disk for manual recovery.
    }
  }
  startup = found.sort((a, b) => a.time - b.time)
}

/**
 * The first window restores the leftovers; later windows get only what was stashed since
 * (see stashBackups).
 */
export function claimStartupBackups(): BackupEntry[] {
  const list = startup ?? []
  startup = []
  return list
}

export async function writeBackup(entry: BackupEntry): Promise<void> {
  if (!entry || !ID_RE.test(entry.id) || typeof entry.content !== 'string') throw new Error('Invalid backup')
  const dir = backupsDir()
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, `${entry.id}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  const data: BackupEntry = {
    id: entry.id,
    path: typeof entry.path === 'string' ? entry.path : null,
    name: String(entry.name),
    kind: entry.kind === 'text' ? 'text' : 'markdown',
    language: typeof entry.language === 'string' ? entry.language : undefined,
    content: entry.content,
    encoding: typeof entry.encoding === 'string' ? entry.encoding : undefined,
    eol: entry.eol === 'crlf' || entry.eol === 'lf' ? entry.eol : undefined,
    savedHash: String(entry.savedHash ?? ''),
    time: Date.now()
  }
  await fs.writeFile(tmp, JSON.stringify(data))
  await fs.rename(tmp, file)
}

export async function deleteBackups(ids: string[]): Promise<void> {
  await Promise.all(
    ids
      .filter((id) => typeof id === 'string' && ID_RE.test(id))
      .map((id) => fs.rm(join(backupsDir(), `${id}.json`), { force: true }))
  )
}

/**
 * A window closed with "Keep for Next Time": its backups stay on disk (so a relaunch restores
 * them) and are also queued for the next window opened in this run of the app — on macOS the
 * app keeps running after its last window closes.
 */
export async function stashBackups(ids: string[]): Promise<void> {
  const pool = startup ?? []
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_RE.test(id) || pool.some((e) => e.id === id)) continue
    try {
      const e = JSON.parse(await fs.readFile(join(backupsDir(), `${id}.json`), 'utf8')) as BackupEntry
      if (e.id === id && typeof e.content === 'string' && typeof e.name === 'string') pool.push(e)
    } catch {
      // Missing or unreadable: it is still restored from disk on the next launch if it exists.
    }
  }
  startup = pool
}
