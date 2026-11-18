/**
 * Sublime-style shortcuts end to end: real keystrokes into the editor, ⌘K chords through the
 * main process, menu accelerators, the command palette / Goto Anything, tabs, jump back,
 * bookmarks, the preview find bar and focus mode.
 *
 *   npm run build && node tests/shortcuts-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { COMMAND_MAP, displayKey, keyOf, toAccelerator } from '../src/shared/keybindings.ts'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-keys-'))
const notes = join(work, 'notes')
cpSync(join(root, 'tests/fixtures/notes'), notes, { recursive: true })
const DOC = ['# Keys', '', 'alpha beta', 'gamma', 'foo bar foo baz foo', '', '## Second', '', 'call(a, [b, c])', 'zeta', 'Alpha', 'beta'].join('\n')
writeFileSync(join(notes, 'keys.md'), DOC)

const platform = process.platform
let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Registry notation → Playwright key: "Shift+Cmd+P" → "Shift+Meta+P". */
const PW = { Cmd: 'Meta', Ctrl: 'Control', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }
const pw = (stroke) =>
  stroke
    .split(/\+(?!$)/)
    .map((p) => PW[p] ?? p)
    .join('+')

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, notes],
  env: { ...process.env, MARKFLOW_USER_DATA: join(work, 'profile') }
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880))
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })

/** Trigger a command through its application-menu item (what a menu accelerator does). */
const menu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id)
    if (!item) throw new Error(`no menu item ${id}`)
    item.click()
  }, id)

/**
 * Native key input through the browser process (so before-input-event sees it, unlike
 * Playwright's CDP keys). Used for ⌘K chords.
 */
const MODS = { Cmd: 'meta', Ctrl: 'control', Alt: 'alt', Shift: 'shift' }
async function nativeKey(stroke) {
  const parts = stroke.split(/\+(?!$)/)
  const keyCode = parts.pop()
  const modifiers = parts.map((p) => MODS[p])
  await app.evaluate(({ BrowserWindow }, [keyCode, modifiers]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }, [keyCode, modifiers])
  await sleep(60)
}

/**
 * Press a command's shortcut. Editor keys are typed into CodeMirror, chords go through the
 * main process, and app-level keys use their menu item (synthetic keys never reach the OS menu;
 * the accelerators themselves are checked against the registry above).
 */
async function press(id) {
  const key = keyOf(id, platform)
  if (key.includes(' ')) {
    for (const stroke of key.split(' ')) await nativeKey(stroke)
  } else if (COMMAND_MAP.get(id).scope === 'editor' || COMMAND_MAP.get(id).native) {
    await page.keyboard.press(pw(key))
  } else {
    await menu(id)
  }
}

const MAIN = '.pane-editor'
async function setDoc(doc, anchor = 0, head = anchor) {
  await page.evaluate(
    ([doc, anchor, head]) => {
      const view = document.querySelector('.pane-editor .cm-content').cmTile.root.view
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor, head } })
      view.focus()
    },
    [doc, anchor, head]
  )
}
/** Move the cursor without touching the document (keeps bookmarks). */
async function setCursor(anchor) {
  await page.evaluate((anchor) => {
    const view = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor } })
    view.focus()
  }, anchor)
}
const cm = (scope = MAIN) =>
  page.evaluate((scope) => {
    const view = document.querySelector(`${scope} .cm-content`).cmTile.root.view
    const s = view.state
    return {
      doc: s.doc.toString(),
      ranges: s.selection.ranges.map((r) => [r.from, r.to]),
      line: s.doc.lineAt(s.selection.main.head).number,
      selected: s.sliceDoc(s.selection.main.from, s.selection.main.to),
      folds: document.querySelectorAll(`${scope} .cm-foldPlaceholder`).length,
      // The gutter's hidden width spacer also holds a marker.
      bookmarks: [...document.querySelectorAll(`${scope} .cm-bookmark-marker`)].filter(
        (el) => getComputedStyle(el.closest('.cm-gutterElement')).visibility !== 'hidden'
      ).length,
      focused: view.hasFocus
    }
  }, scope)
const offset = (doc, line, col = 0) => doc.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0) + col
const activeTab = () => page.textContent('.tab.active .tab-name')
const waitFor = (fn, arg, timeout = 3000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false)

try {
  await page.waitForSelector('.tree-row')

  console.log('▶ menu accelerators come from the shared registry')
  const accel = await app.evaluate(({ Menu }, ids) => {
    const m = Menu.getApplicationMenu()
    return Object.fromEntries(ids.map((id) => [id, { accelerator: m.getMenuItemById(id)?.accelerator ?? null, label: m.getMenuItemById(id)?.label ?? null }]))
  }, ['format-link', 'format-h2', 'tab-1', 'toggle-view', 'use-selection-find', 'split-into-lines', 'goto-heading', 'upper-case', 'command-palette'])
  for (const id of ['format-link', 'format-h2', 'tab-1', 'toggle-view', 'use-selection-find', 'split-into-lines', 'goto-heading', 'command-palette']) {
    check(accel[id].accelerator === toAccelerator(keyOf(id, platform)), `${id}: ${accel[id].accelerator}`)
  }
  check(!accel['upper-case'].accelerator && accel['upper-case'].label.includes(displayKey(keyOf('upper-case', platform), platform)), `chord shown in the label: ${accel['upper-case'].label.trim()}`)

  await page.click('.tree-row:has-text("keys.md")')
  await menu('view-edit')
  await page.waitForSelector(`${MAIN} .cm-content`)
  await sleep(200)

  console.log('▶ line editing keys (real keystrokes into the editor)')
  await setDoc('a\nb\nc', 0)
  await press('duplicate-line')
  check((await cm()).doc === 'a\na\nb\nc', 'duplicate line')
  await setDoc('a\nb\nc', 0)
  await press('swap-line-down')
  check((await cm()).doc === 'b\na\nc', 'swap line down')
  await press('swap-line-up')
  check((await cm()).doc === 'a\nb\nc', 'swap line up')
  await setDoc('foo  \n   bar\nbaz', 0)
  await press('join-lines')
  check((await cm()).doc === 'foo bar\nbaz', 'join lines')
  await setDoc('a\nb', 3)
  await press('delete-line')
  check((await cm()).doc === 'a', 'delete line')
  await setDoc('  x', 3)
  await press('insert-line-before')
  check((await cm()).doc === '  \n  x', 'insert line before')
  await setDoc('a\nb', 0)
  await press('insert-line-after')
  check((await cm()).doc === 'a\n\nb', 'insert line after')
  await setDoc('x', 0)
  await press('indent')
  check(/^\s+x$/.test((await cm()).doc), 'indent')
  await press('outdent')
  check((await cm()).doc === 'x', 'outdent')
  await setDoc('b\nC\na\nA', 0)
  await press('sort-lines')
  check((await cm()).doc === 'A\na\nb\nC', 'sort lines (case-insensitive)')
  await setDoc('note', 0)
  await press('toggle-comment')
  check((await cm()).doc === '<!-- note -->', 'toggle comment')

  console.log('▶ selection keys')
  await setDoc('ab\ncd\nef', 0, 8)
  await press('split-into-lines')
  check((await cm()).ranges.length === 3, 'split selection into lines (3 cursors)')
  await setDoc('foo bar foo baz foo', 1)
  await press('select-next-occurrence')
  await press('select-next-occurrence')
  check((await cm()).ranges.length === 2, 'select next occurrence twice → 2 selections')
  await setDoc('foo bar foo baz foo', 1)
  await press('select-all-occurrences')
  check((await cm()).ranges.length === 3, 'select all occurrences')
  await setDoc('a\nb\nc', 2)
  await press('select-line')
  check((await cm()).selected === 'b\n', 'select line')
  await setDoc('a\nb\nc', 0)
  await press('add-cursor-below')
  check((await cm()).ranges.length === 2, 'add cursor below')
  await setDoc('call(a, [b, c])', 10)
  await press('expand-brackets')
  check((await cm()).selected === 'b, c', 'expand selection to brackets')
  await setDoc('call(a, [b, c])', 4)
  await press('jump-bracket')
  check((await cm()).ranges[0][0] >= 14, `jump to matching bracket (${(await cm()).ranges[0][0]})`)
  await setDoc('one two', 0, 3)
  await page.keyboard.press('ArrowRight')
  await press('soft-undo')
  check((await cm()).selected === 'one', 'soft undo restores the previous selection')

  console.log('▶ Markdown formatting keys')
  await setDoc('Title', 0)
  await press('format-h2')
  check((await cm()).doc === '## Title', `heading 2 with ${displayKey(keyOf('format-h2', platform), platform)}`)
  await setDoc('site', 0, 4)
  await press('format-link')
  check((await cm()).doc.startsWith('[site]('), `insert link with ${displayKey(keyOf('format-link', platform), platform)}`)
  await setDoc('bold', 0, 4)
  await press('format-bold')
  check((await cm()).doc === '**bold**', 'bold unchanged on ⌘B')

  console.log('▶ ⌘K chords (intercepted by the main process)')
  await setDoc('hello world', 1)
  await nativeKey(keyOf('upper-case', platform).split(' ')[0])
  const hint = await waitFor(() => !!document.querySelector('.chord-hint'))
  check(hint, `chord hint shown: ${hint ? await page.textContent('.chord-hint') : ''}`)
  await nativeKey(keyOf('upper-case', platform).split(' ')[1])
  check((await cm()).doc === 'HELLO world', 'upper case (⌘K ⌘U)')
  check(!(await page.$('.chord-hint')), 'chord hint cleared')
  await setDoc('HELLO world', 0, 11)
  await press('lower-case')
  check((await cm()).doc === 'hello world', 'lower case (⌘K ⌘L)')
  await setDoc('keep|drop', 4)
  await press('delete-to-eol')
  check((await cm()).doc === 'keep', 'delete to end of line (⌘K ⌘K)')
  await setDoc('bold?', 0, 4)
  const sidebarBefore = !!(await page.$('.sidebar-wrap'))
  await nativeKey(keyOf('upper-case', platform).split(' ')[0])
  await nativeKey(keyOf('format-bold', platform))
  await sleep(150)
  check(!!(await page.$('.sidebar-wrap')) !== sidebarBefore, '⌘K ⌘B toggles the sidebar…')
  check((await cm()).doc === 'bold?', '…without applying bold (second stroke swallowed)')
  await press('toggle-sidebar')
  await sleep(100)
  check(!!(await page.$('.sidebar-wrap')) === sidebarBefore, 'sidebar restored with the primary key')
  await setDoc('x', 0)
  await nativeKey(keyOf('upper-case', platform).split(' ')[0])
  await nativeKey('Escape')
  await nativeKey(keyOf('format-bold', platform))
  check((await cm()).doc.includes('**'), 'Esc cancels a pending chord (⌘B applies bold again)')
  await setDoc(DOC, 0)
  await sleep(300)
  await press('fold-level-2')
  await sleep(150)
  const folded = (await cm()).folds
  check(folded >= 1, `fold level 2 (⌘K ⌘2): ${folded} fold(s)`)
  await press('unfold-all')
  await sleep(100)
  check((await cm()).folds === 0, 'unfold all (⌘K ⌘0)')
  await shot('40-shortcuts-editor')

  console.log('▶ menu path routes editor commands to the focused editor')
  await setDoc('m', 0)
  await menu('duplicate-line')
  check((await cm()).doc === 'm\nm', 'Edit ▸ Line ▸ Duplicate')

  console.log('▶ command palette & Goto Anything')
  await setDoc(DOC, 0)
  await press('command-palette')
  await page.waitForSelector('.palette input')
  check((await page.inputValue('.palette input')) === '>', 'palette opens with ">"')
  await page.keyboard.type('toggle-sidebar')
  await sleep(100)
  const rowKey = await page.textContent('.palette .qo-item.active .qo-key')
  check(rowKey === displayKey(keyOf('toggle-sidebar', platform), platform), `palette shows the shortcut (${rowKey})`)
  await shot('41-command-palette')
  const hadSidebar = !!(await page.$('.sidebar-wrap'))
  await page.keyboard.press('Enter')
  await sleep(150)
  check(!(await page.$('.palette')) && !!(await page.$('.sidebar-wrap')) !== hadSidebar, 'palette runs the command')
  await menu('toggle-sidebar')

  await press('goto-line')
  await page.waitForSelector('.palette input')
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await sleep(200)
  check((await cm()).line === 10, `go to line 10 (⌃G): line ${(await cm()).line}`)
  check((await cm()).focused, 'editor focused again after the palette closes')

  await press('goto-heading')
  await page.waitForSelector('.palette .qo-item')
  const headingRows = await page.$$eval('.palette .qo-item .qo-label', (els) => els.map((e) => e.textContent))
  check(headingRows.join('|') === 'Keys|Second', `go to heading lists headings: ${headingRows.join(', ')}`)
  await page.keyboard.type('sec')
  await page.keyboard.press('Enter')
  await sleep(200)
  check((await cm()).line === 7, `jumped to "## Second" (line ${(await cm()).line})`)

  console.log('▶ jump back / forward')
  await press('jump-back')
  await sleep(200)
  check((await cm()).line === 10, `jump back → line ${(await cm()).line}`)
  await press('jump-forward')
  await sleep(200)
  check((await cm()).line === 7, `jump forward → line ${(await cm()).line}`)

  await press('goto-heading-project')
  await page.waitForSelector('.palette input')
  await page.keyboard.type('任务列表')
  await page.waitForSelector('.palette .qo-item')
  await page.keyboard.press('Enter')
  const guideOpened = await waitFor(() => document.querySelector('.tab.active .tab-name')?.textContent === 'guide.md')
  check(guideOpened, 'heading in folder (⇧⌘R) opens guide.md')
  await sleep(300)
  check((await cm()).doc.split('\n')[(await cm()).line - 1].includes('任务列表'), `cursor on the heading (line ${(await cm()).line})`)

  await press('quick-open')
  await page.waitForSelector('.palette input')
  await page.keyboard.type('page:3')
  await page.keyboard.press('Enter')
  const pageOpened = await waitFor(() => document.querySelector('.tab.active .tab-name')?.textContent === 'page.md')
  await sleep(300)
  check(pageOpened && (await cm()).line === 3, `Goto Anything "page:3" opens page.md at line ${(await cm()).line}`)

  console.log('▶ tabs')
  const tabs = await page.$$eval('.tab .tab-name', (els) => els.map((e) => e.textContent))
  await press('tab-1')
  await sleep(100)
  check((await activeTab()) === tabs[0], `tab 1 (${displayKey(keyOf('tab-1', platform), platform)}) → ${await activeTab()}`)
  await menu('tab-2')
  await sleep(100)
  check((await activeTab()) === tabs[1], `tab 2 → ${await activeTab()}`)
  await page.keyboard.press('Control+Tab')
  await sleep(100)
  check((await activeTab()) === tabs[2], `⌃Tab → ${await activeTab()}`)
  await page.keyboard.press('Control+Shift+Tab')
  await sleep(100)
  check((await activeTab()) === tabs[1], `⌃⇧Tab → ${await activeTab()}`)
  await press('jump-back')
  await sleep(200)
  check((await activeTab()) === tabs[2], `jump back across tabs → ${await activeTab()}`)

  console.log('▶ bookmarks')
  await press('tab-1')
  await sleep(150)
  await setDoc(DOC, offset(DOC, 3))
  await menu('bookmark-toggle')
  await setCursor(offset(DOC, 9))
  await menu('bookmark-toggle')
  await sleep(50)
  check((await cm()).bookmarks === 2, 'two bookmarks in the gutter')
  await setCursor(0)
  await press('bookmark-next')
  check((await cm()).line === 3, `F2 → line ${(await cm()).line}`)
  await press('bookmark-next')
  check((await cm()).line === 9, `F2 → line ${(await cm()).line}`)
  await press('bookmark-prev')
  check((await cm()).line === 3, `⇧F2 → line ${(await cm()).line}`)
  await menu('bookmark-clear')
  await sleep(50)
  check((await cm()).bookmarks === 0, 'bookmarks cleared')

  console.log('▶ reading mode: find with the selection, toggles, block editor ⌘↩')
  await page.click('.tree-row:has-text("README.md")')
  await press('view-preview')
  await page.waitForSelector('.markdown-body h1')
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.markdown-body'), NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf('端到端测试')
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + 5)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      break
    }
  })
  await press('use-selection-find')
  await page.waitForSelector('.findbar input')
  await sleep(100)
  check((await page.inputValue('.findbar input')) === '端到端测试', `⌘E seeds the find bar: "${await page.inputValue('.findbar input')}"`)
  await page.fill('.findbar input', '任务')
  await sleep(150)
  const before = await page.textContent('.find-count')
  await menu('find-next')
  await sleep(100)
  const after = await page.textContent('.find-count')
  check(before !== after, `⌘G steps through matches (${before} → ${after})`)
  await page.focus('.findbar input')
  const onBefore = await page.$$eval('.findbar button.on', (b) => b.length)
  await press('find-toggle-regex')
  await sleep(100)
  check((await page.$$eval('.findbar button.on', (b) => b.length)) === onBefore + 1, 'regex toggle in the find bar')
  await page.focus('.findbar input')
  await menu('format-codeblock')
  await sleep(100)
  check((await page.$$eval('.findbar button.on', (b) => b.length)) === onBefore + 2, '⌥⌘C toggles case while the find bar has focus')
  await page.keyboard.press('Escape')

  await page.locator('.markdown-body > p', { hasText: '端到端测试' }).dblclick()
  await page.waitForSelector('.mf-block-editor .cm-content')
  await page.keyboard.type('!')
  await menu('insert-line-after')
  const finished = await waitFor(() => !document.querySelector('.mf-block-editor'))
  check(finished, '⌘↩ finishes the inline block edit')

  console.log('▶ focus mode')
  await press('view-edit')
  await menu('focus-mode')
  check(await waitFor(() => !!document.querySelector('.app.focus-mode') && !document.querySelector('.titlebar')?.offsetHeight), 'focus mode hides the chrome')
  const full = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    for (let i = 0; i < 40 && !win.isFullScreen(); i++) await new Promise((r) => setTimeout(r, 100))
    return win.isFullScreen()
  })
  check(full, 'window entered full screen')
  await sleep(800)
  await shot('42-focus-mode')
  await menu('focus-mode')
  const left = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    for (let i = 0; i < 40 && win.isFullScreen(); i++) await new Promise((r) => setTimeout(r, 100))
    return !win.isFullScreen()
  })
  check(left && !(await page.$('.app.focus-mode')), 'focus mode and full screen left together')
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  await sleep(300)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll shortcut checks passed')
process.exit(failures ? 1 : 0)
