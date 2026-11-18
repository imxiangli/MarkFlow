/** Format of latest.json published next to the content-addressed file store. */
export interface UpdateFile {
  /** Path relative to the app root, e.g. "out/renderer/assets/index-abc.js". */
  path: string
  sha256: string
  size: number
  /** Size of files/<sha256>.gz on the server. */
  gzSize: number
}

export interface FullPackage {
  name: string
  /** Relative to the update base URL, or absolute. */
  url: string
  sha512: string
  size: number
}

export interface UpdateManifest {
  schema: 1
  version: string
  date: string
  notes?: string | Record<string, string>
  /** Electron runtime the app files were built for; hot updates require an exact match. */
  electron: string
  /** Minimum bootstrap contract version (see src/bootstrap/index.ts). */
  bootstrapApi: number
  files: UpdateFile[]
  /** Installers keyed by `${process.platform}-${process.arch}`, used when a hot update is impossible. */
  full?: Record<string, FullPackage>
}

export type UpdateStatus =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'full-available'
  | 'full-downloading'
  | 'full-ready'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  baseVersion: string
  /** Running code came from an incremental update. */
  hot: boolean
  latestVersion?: string
  notes?: string
  /** Bytes to download / downloaded so far for the current operation. */
  total?: number
  downloaded?: number
  filesTotal?: number
  filesToDownload?: number
  /** Size of the full installer, for comparison. */
  fullSize?: number
  installerPath?: string
  error?: string
  /** Reason the updater is disabled: 'no-url' | 'dev'. */
  disabledReason?: string
  lastChecked?: number
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}
