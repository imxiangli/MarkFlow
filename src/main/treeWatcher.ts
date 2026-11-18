/**
 * Watches a workspace folder for changes.
 *
 * macOS and Windows: one native recursive watcher (FSEvents / ReadDirectoryChangesW). chokidar
 * would open a watcher per file and folder; on macOS each is an FSEvents stream, and closing
 * thousands of them (on quit, or when switching folders) froze the app for many seconds.
 * Linux: chokidar on inotify, where per-directory watches are cheap.
 */
import { watch as fsWatch, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'

export interface TreeChange {
  path: string
  /** false once the path no longer exists (deleted / renamed away). */
  exists: boolean
  isDir: boolean
}

export interface TreeWatcherOptions {
  /** True for single path segments that are never watched (node_modules, hidden files…). */
  ignoreName: (name: string) => boolean
  onChange: (change: TreeChange) => void
  /** Events were dropped by the OS: the whole tree should be rescanned. */
  onRescan: () => void
  /** Quiet period per path before it is reported (lets writes finish). */
  delay?: number
}

export interface TreeWatcher {
  close(): void
}

/** Platforms with an efficient single-handle recursive watcher. */
export const nativeRecursiveWatch = process.platform === 'darwin' || process.platform === 'win32'

export function watchTree(root: string, options: TreeWatcherOptions): TreeWatcher {
  return nativeRecursiveWatch ? watchNative(root, options) : watchWithChokidar(root, options)
}

function watchNative(root: string, options: TreeWatcherOptions): TreeWatcher {
  const delay = options.delay ?? 120
  const pending = new Map<string, NodeJS.Timeout>()
  let closed = false

  const report = async (path: string) => {
    pending.delete(path)
    let isDir = false
    let exists = true
    try {
      isDir = (await fs.stat(path)).isDirectory()
    } catch {
      exists = false
    }
    if (!closed) options.onChange({ path, exists, isDir })
  }

  const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (closed) return
    if (!filename) {
      options.onRescan()
      return
    }
    const rel = filename.toString()
    if (rel.split(/[\\/]/).some((segment) => segment !== '' && options.ignoreName(segment))) return
    const path = join(root, rel)
    clearTimeout(pending.get(path))
    pending.set(
      path,
      setTimeout(() => void report(path), delay)
    )
  })
  watcher.on('error', (err) => console.warn('[watcher]', err))

  return {
    close() {
      if (closed) return
      closed = true
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      watcher.close()
    }
  }
}

function watchWithChokidar(root: string, options: TreeWatcherOptions): TreeWatcher {
  const watcher = chokidarWatch(root, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    depth: 32,
    awaitWriteFinish: { stabilityThreshold: options.delay ?? 120, pollInterval: 40 },
    ignored: (p: string) => p !== root && options.ignoreName(basename(p))
  })
  watcher.on('all', (event, path) => {
    options.onChange({
      path,
      exists: event === 'add' || event === 'addDir' || event === 'change',
      isDir: event === 'addDir' || event === 'unlinkDir'
    })
  })
  watcher.on('error', (err) => console.warn('[watcher]', err))
  return {
    close() {
      void watcher.close()
    }
  }
}
