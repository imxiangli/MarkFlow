import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { toAssetUrl } from '@shared/constants'
import type { MarkFlowAPI } from '@shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: MarkFlowAPI = {
  platform: process.platform,
  getInitialState: () => ipcRenderer.invoke('mf:get-initial-state'),
  rendererReady: () => ipcRenderer.send('mf:renderer-ready'),
  onOpenPaths: (cb) => on('mf:open-paths', cb),
  onMenuCommand: (cb) => on('mf:menu-command', cb),
  onBeforeClose: (cb) => on('mf:before-close', cb),
  onSettingsChanged: (cb) => on('mf:settings-changed', cb),
  onRecentChanged: (cb) => on('mf:recent-changed', cb),
  onTreeChanged: (cb) => on('mf:tree-changed', cb),
  onFileChanged: (cb) => on('mf:file-changed', cb),
  closeWindow: () => ipcRenderer.send('mf:close-window'),
  closeCancelled: () => ipcRenderer.send('mf:close-cancelled'),
  newWindow: () => ipcRenderer.send('mf:new-window'),

  showOpenFile: (defaultPath) => ipcRenderer.invoke('mf:show-open-file', defaultPath),
  showOpenFolder: () => ipcRenderer.invoke('mf:show-open-folder'),
  showSaveDialog: (defaultPath, filters) => ipcRenderer.invoke('mf:show-save-dialog', defaultPath, filters),
  showMessageBox: (options) => ipcRenderer.invoke('mf:show-message-box', options),

  readFile: (path, encoding) => ipcRenderer.invoke('mf:read-file', path, encoding),
  writeFile: (path, content, options) => ipcRenderer.invoke('mf:write-file', path, content, options),
  fileIcon: (path) => ipcRenderer.invoke('mf:file-icon', path),
  largeOpen: (path, encoding) => ipcRenderer.invoke('mf:large-open', path, encoding),
  largeRead: (id) => ipcRenderer.invoke('mf:large-read', id),
  largeClose: (id) => ipcRenderer.invoke('mf:large-close', id),
  largeWriteBegin: (path, options) => ipcRenderer.invoke('mf:large-write-begin', path, options),
  largeWriteChunk: (id, text) => ipcRenderer.invoke('mf:large-write-chunk', id, text),
  largeWriteEnd: (id) => ipcRenderer.invoke('mf:large-write-end', id),
  largeWriteAbort: (id) => ipcRenderer.invoke('mf:large-write-abort', id),
  stat: (path) => ipcRenderer.invoke('mf:stat', path),
  createFile: (path, content) => ipcRenderer.invoke('mf:create-file', path, content),
  createDir: (path) => ipcRenderer.invoke('mf:create-dir', path),
  rename: (oldPath, newPath) => ipcRenderer.invoke('mf:rename', oldPath, newPath),
  trash: (path) => ipcRenderer.invoke('mf:trash', path),
  saveImage: (dir, fileName, data) => ipcRenderer.invoke('mf:save-image', dir, fileName, data),
  copyFile: (src, dest) => ipcRenderer.invoke('mf:copy-file', src, dest),

  openWorkspace: (root, options) => ipcRenderer.invoke('mf:open-workspace', root, options),
  refreshWorkspace: (options) => ipcRenderer.invoke('mf:refresh-workspace', options),
  closeWorkspace: () => ipcRenderer.invoke('mf:close-workspace'),
  watchFiles: (paths) => ipcRenderer.send('mf:watch-files', paths),
  searchInFolder: (root, query, options) => ipcRenderer.invoke('mf:search', root, query, options),

  openExternal: (url) => ipcRenderer.invoke('mf:open-external', url),
  showItemInFolder: (path) => ipcRenderer.send('mf:show-item-in-folder', path),
  openPath: (path) => ipcRenderer.invoke('mf:open-path', path),
  copyText: (text) => ipcRenderer.send('mf:copy-text', text),
  readClipboardText: () => ipcRenderer.invoke('mf:read-clipboard'),
  setFullScreen: (flag) => ipcRenderer.send('mf:set-fullscreen', flag),
  onFullScreen: (cb) => on('mf:fullscreen', cb),
  onChord: (cb) => on('mf:chord', cb),
  onChordPending: (cb) => on('mf:chord-pending', cb),
  listHeadings: (root, options) => ipcRenderer.invoke('mf:list-headings', root, options),

  setSettings: (partial) => ipcRenderer.invoke('mf:set-settings', partial),
  addRecent: (path, kind) => ipcRenderer.send('mf:add-recent', path, kind),
  clearRecent: () => ipcRenderer.send('mf:clear-recent'),
  setSession: (session) => ipcRenderer.send('mf:set-session', session),
  setDocumentState: (state) => ipcRenderer.send('mf:set-document-state', state),

  exportPDF: (defaultPath) => ipcRenderer.invoke('mf:export-pdf', defaultPath),
  print: () => ipcRenderer.invoke('mf:print'),
  setDefaultApp: () => ipcRenderer.invoke('mf:set-default-app'),

  writeBackup: (entry) => ipcRenderer.invoke('mf:backup-write', entry),
  deleteBackups: (ids) => ipcRenderer.invoke('mf:backup-delete', ids),
  stashBackups: (ids) => ipcRenderer.invoke('mf:backup-stash', ids),

  getUpdateState: () => ipcRenderer.invoke('mf:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('mf:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('mf:update-download'),
  installUpdate: () => ipcRenderer.invoke('mf:update-install'),
  onUpdateState: (cb) => on('mf:update-state', cb),

  getPathForFile: (file) => webUtils.getPathForFile(file),
  toAssetUrl
}

contextBridge.exposeInMainWorld('mf', api)
