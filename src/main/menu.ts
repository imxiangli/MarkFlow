import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { basename } from 'node:path'
import type { MenuCommand } from '@shared/types'
import { COMMAND_MAP, displayKey, isChord, keyOf, toAccelerator } from '@shared/keybindings'
import { mt } from './locale'
import { getStore } from './store'
import { createWindow, openPathsInApp, sendCommand } from './windows'

const isMac = process.platform === 'darwin'
type Item = MenuItemConstructorOptions

/**
 * Menu item for a command from the shared registry: the label comes from i18n and the
 * shortcut from src/shared/keybindings.ts. Chords and "native" shortcuts can't be menu
 * accelerators, so they are appended to the label instead.
 */
function cmd(id: MenuCommand, label?: string): Item {
  const def = COMMAND_MAP.get(id)
  const text = label ?? (def ? mt(def.label, def.labelVars) : id)
  const key = keyOf(id, process.platform)
  const accelerator = def?.native ? undefined : toAccelerator(key)
  const hint = key && (def?.native || isChord(key)) ? `    ${displayKey(key, process.platform)}` : ''
  return { id, label: text + hint, accelerator, click: () => sendCommand(id) }
}

const sep: Item = { type: 'separator' }

function recentSubmenu(): Item[] {
  const recent = getStore().recent
  const items: Item[] = recent.slice(0, 15).map((r) => ({
    label: `${r.kind === 'folder' ? '📁 ' : ''}${basename(r.path) || r.path}  —  ${r.path}`,
    click: () => void openPathsInApp([r.path])
  }))
  if (!items.length) items.push({ label: mt('menu.noRecent'), enabled: false })
  items.push(sep, { label: mt('menu.clearRecent'), click: () => sendCommand('clear-recent') })
  return items
}

export function buildMenu(): void {
  const theme = getStore().settings.theme
  const template: Item[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        cmd('about'),
        cmd('check-updates'),
        sep,
        cmd('settings'),
        sep,
        { role: 'services', label: mt('menu.services') },
        sep,
        { role: 'hide', label: mt('menu.hide') },
        { role: 'hideOthers', label: mt('menu.hideOthers') },
        { role: 'unhide', label: mt('menu.unhide') },
        sep,
        { role: 'quit', label: mt('menu.quit') }
      ]
    })
  }

  template.push({
    label: mt('menu.file'),
    submenu: [
      cmd('new-file'),
      { ...cmd('new-window'), click: () => createWindow({}) },
      sep,
      cmd('open-file'),
      cmd('open-folder'),
      { label: mt('menu.openRecent'), submenu: recentSubmenu() },
      cmd('close-folder'),
      sep,
      cmd('save'),
      cmd('save-as'),
      cmd('save-all'),
      sep,
      cmd('export-html'),
      cmd('export-pdf'),
      cmd('print'),
      sep,
      cmd('close-tab'),
      cmd('reopen-closed-tab'),
      { role: 'close', label: mt('menu.closeWindow'), accelerator: toAccelerator(keyOf('close-window', process.platform)) },
      ...(isMac ? [] : [sep, cmd('settings'), sep, { role: 'quit', label: mt('menu.exit') } as Item])
    ]
  })

  template.push({
    label: mt('menu.edit'),
    submenu: [
      // Routed to the renderer so undo also works in reading mode (block edits, checkboxes).
      cmd('undo'),
      cmd('redo'),
      cmd('soft-undo'),
      sep,
      { role: 'cut', label: mt('menu.cut') },
      { role: 'copy', label: mt('menu.copy') },
      { role: 'paste', label: mt('menu.paste') },
      cmd('paste-indent'),
      // CodeMirror virtualises long documents, so "select all" is routed to the renderer.
      cmd('select-all'),
      sep,
      {
        label: mt('cmd.groupLine'),
        submenu: [
          cmd('indent'),
          cmd('outdent'),
          sep,
          cmd('swap-line-up'),
          cmd('swap-line-down'),
          cmd('duplicate-line'),
          cmd('delete-line'),
          cmd('join-lines')
        ]
      },
      {
        label: mt('cmd.groupText'),
        submenu: [
          cmd('insert-line-after'),
          cmd('insert-line-before'),
          sep,
          cmd('delete-to-eol'),
          cmd('delete-to-bol'),
          sep,
          cmd('toggle-comment'),
          cmd('toggle-block-comment'),
          sep,
          cmd('upper-case'),
          cmd('lower-case')
        ]
      },
      {
        label: mt('cmd.groupFold'),
        submenu: [
          cmd('fold'),
          cmd('unfold'),
          cmd('fold-all'),
          cmd('unfold-all'),
          sep,
          ...[1, 2, 3, 4, 5, 6].map((n) => cmd(`fold-level-${n}` as MenuCommand))
        ]
      },
      sep,
      cmd('sort-lines'),
      cmd('sort-lines-case')
    ]
  })

  template.push({
    label: mt('menu.selection'),
    submenu: [
      cmd('split-into-lines'),
      cmd('add-cursor-above'),
      cmd('add-cursor-below'),
      sep,
      cmd('select-line'),
      cmd('expand-brackets'),
      cmd('expand-indentation'),
      cmd('expand-scope')
    ]
  })

  template.push({
    label: mt('menu.findMenu'),
    submenu: [
      cmd('find'),
      cmd('find-next'),
      cmd('find-prev'),
      cmd('replace'),
      sep,
      cmd('quick-find-next'),
      cmd('select-all-occurrences'),
      cmd('select-next-occurrence'),
      cmd('skip-occurrence'),
      sep,
      cmd('use-selection-find'),
      sep,
      cmd('find-toggle-regex'),
      cmd('find-toggle-case'),
      cmd('find-toggle-word'),
      sep,
      cmd('search-in-folder')
    ]
  })

  template.push({
    label: mt('menu.view'),
    submenu: [
      cmd('toggle-sidebar'),
      cmd('show-files'),
      cmd('show-outline'),
      sep,
      cmd('view-preview'),
      cmd('view-edit'),
      cmd('view-split'),
      cmd('toggle-view'),
      cmd('toggle-minimap'),
      sep,
      {
        label: mt('menu.theme'),
        submenu: [
          { label: mt('menu.themeSystem'), type: 'radio', checked: theme === 'system', click: () => sendCommand('theme-system') },
          { label: mt('menu.themeLight'), type: 'radio', checked: theme === 'light', click: () => sendCommand('theme-light') },
          { label: mt('menu.themeDark'), type: 'radio', checked: theme === 'dark', click: () => sendCommand('theme-dark') }
        ]
      },
      sep,
      { role: 'zoomIn', label: mt('menu.zoomIn') },
      { role: 'zoomOut', label: mt('menu.zoomOut') },
      { role: 'resetZoom', label: mt('menu.resetZoom') },
      sep,
      { role: 'togglefullscreen', label: mt('menu.fullscreen') },
      cmd('focus-mode'),
      sep,
      { role: 'toggleDevTools', label: mt('menu.devtools') }
    ]
  })

  template.push({
    label: mt('menu.goto'),
    submenu: [
      cmd('quick-open'),
      cmd('command-palette'),
      sep,
      cmd('goto-heading'),
      cmd('goto-heading-project'),
      cmd('goto-line'),
      sep,
      cmd('jump-back'),
      cmd('jump-forward'),
      sep,
      {
        label: mt('cmd.groupTabs'),
        submenu: [cmd('next-tab'), cmd('prev-tab'), sep, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => cmd(`tab-${n}` as MenuCommand))]
      },
      {
        label: mt('cmd.groupBookmarks'),
        submenu: [cmd('bookmark-toggle'), cmd('bookmark-next'), cmd('bookmark-prev'), cmd('bookmark-clear')]
      },
      sep,
      cmd('jump-bracket')
    ]
  })

  template.push({
    label: mt('menu.format'),
    submenu: [
      cmd('format-bold'),
      cmd('format-italic'),
      cmd('format-strike'),
      cmd('format-code'),
      cmd('format-link'),
      cmd('format-image'),
      sep,
      ...[1, 2, 3, 4, 5, 6].map((n) => cmd(`format-h${n}` as MenuCommand)),
      sep,
      cmd('format-quote'),
      cmd('format-ul'),
      cmd('format-ol'),
      cmd('format-task'),
      sep,
      cmd('format-codeblock'),
      cmd('format-table'),
      cmd('format-math'),
      cmd('format-hr')
    ]
  })

  template.push({
    label: mt('menu.window'),
    submenu: [
      { role: 'minimize', label: mt('menu.minimize') },
      { role: 'zoom', label: mt('menu.zoom') },
      ...(isMac ? [sep, { role: 'front', label: mt('menu.front') } as Item] : [])
    ]
  })

  template.push({
    role: 'help',
    label: mt('menu.help'),
    submenu: [
      cmd('markdown-guide'),
      sep,
      { label: 'CommonMark Spec', click: () => void shell.openExternal('https://spec.commonmark.org/') },
      { label: 'GitHub Flavored Markdown', click: () => void shell.openExternal('https://github.github.com/gfm/') },
      ...(isMac ? [] : [sep, cmd('check-updates'), cmd('about')])
    ]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  if (isMac) {
    app.dock?.setMenu(Menu.buildFromTemplate([{ label: mt('menu.newWindow'), click: () => createWindow({}) }]))
  }
}
