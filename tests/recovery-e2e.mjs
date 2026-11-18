/**
 * Crash recovery ("hot exit") end-to-end test.
 *
 *   npm run build && node tests/recovery-e2e.mjs
 *
 * Edits a new untitled document and an existing file, kills the app with SIGKILL, and checks
 * that both come back unsaved on the next launch — plus the cases where backups must NOT
 * come back (saved, or discarded with "Don't Save") — and that "Keep for Next Time" on a normal
 * quit brings them back too.
 */
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'markflow-recovery-'))
const notes = join(work, 'notes')
cpSync(join(root, 'tests/fixtures/notes'), notes, { recursive: true })
const profile = join(work, 'profile')
const backupsDir = join(profile, 'backups')
const readme = join(notes, 'README.md')
const originalReadme = readFileSync(readme, 'utf8')

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const backups = () => (existsSync(backupsDir) ? readdirSync(backupsDir).filter((n) => n.endsWith('.json')) : [])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch(args = []) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, ...args],
    env: { ...process.env, MARKFLOW_USER_DATA: profile }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20000 })
  await sleep(500)
  const send = (cmd) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)
  return { app, page, send }
}

/** Answer the next save prompt with the button labelled `label`; records the buttons shown. */
async function answerWith(app, label) {
  await app.evaluate(({ dialog }, re) => {
    globalThis.__prompts = []
    dialog.showMessageBox = async (...args) => {
      const opts = args.find((a) => a && Array.isArray(a.buttons))
      globalThis.__prompts.push(opts.buttons)
      return { response: Math.max(0, opts.buttons.findIndex((b) => new RegExp(re).test(b))), checkboxChecked: false }
    }
  }, label)
}
const promptsShown = (app) => app.evaluate(() => globalThis.__prompts ?? [])

async function quit(app) {
  const closed = new Promise((r) => app.process().once('exit', r))
  await app.evaluate(({ app: a }) => a.quit())
  await closed
}

async function crash(app) {
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', r))
  proc.kill('SIGKILL')
  await exited
}

async function typeInEditor(page, text) {
  await page.click('.cm-content')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type(text)
}

const previewText = (page) => page.textContent('.markdown-body')

let app, page, send
try {
  console.log('▶ edit a new document and an existing file, then crash')
  ;({ app, page, send } = await launch([notes]))
  await send('view-split')
  await send('new-file')
  await page.waitForSelector('.tab.active:has-text("未命名-1.md"), .tab.active:has-text("Untitled-1.md")')
  await typeInEditor(page, '# 崩溃前的新文档\n\n新文档内容 ABC123')
  await page.click('.tree-row:has-text("README.md")')
  await page.waitForSelector('.tab.active:has-text("README.md")')
  await typeInEditor(page, '\n\n未保存的修改 XYZ789')
  await sleep(1500)
  const before = backups()
  check(before.length === 2, `2 backups written while editing (${before.length})`)
  await crash(app)
  check(readFileSync(readme, 'utf8') === originalReadme, 'README.md on disk untouched by the crash')

  console.log('▶ relaunch restores both documents unsaved')
  ;({ app, page, send } = await launch())
  await page.waitForSelector('.toast', { timeout: 5000 }).catch(() => null)
  const toastText = (await page.textContent('.toasts').catch(() => '')) ?? ''
  check(/恢复 2 个|Restored 2/.test(toastText), `restore notice: "${toastText.trim()}"`)
  const tabs = await page.$$eval('.tab', (els) => els.map((e) => `${e.querySelector('.tab-name').textContent}${e.classList.contains('dirty') ? '*' : ''}`))
  check(tabs.includes('README.md*') && tabs.some((n) => /^(未命名|Untitled)-1\.md\*$/.test(n)), `tabs: ${tabs.join(', ')}`)
  await page.click('.tab:has-text("README.md")')
  await sleep(400)
  check((await previewText(page)).includes('XYZ789'), 'README.md shows the unsaved edit')
  await page.click('.tab:has-text("-1.md")')
  await sleep(400)
  check((await previewText(page)).includes('ABC123'), 'new document content restored')
  check(backups().length === 2 && backups().every((b) => before.includes(b)), 'restored tabs keep their original backup files')

  console.log('▶ external change while crashed is flagged as a conflict')
  await crash(app)
  writeFileSync(readme, originalReadme + '\n外部程序写入的内容\n')
  ;({ app, page, send } = await launch())
  await page.click('.tab:has-text("README.md")')
  await sleep(400)
  check(!!(await page.$('.banner')), 'conflict banner shown for README.md')
  check((await previewText(page)).includes('XYZ789'), 'unsaved edit still restored')

  console.log('▶ saving removes the backup')
  await send('save')
  await sleep(600)
  check(readFileSync(readme, 'utf8').includes('XYZ789'), 'README.md saved with the restored edit')
  check(backups().length === 1, `only the untitled backup remains (${backups().length})`)

  console.log('▶ a new document keeps its type')
  await send('new-file')
  await typeInEditor(page, '<p>类型恢复 TYPE42</p>')
  await sleep(1200)
  await page.click('.statusbar .status-syntax')
  await page.locator('.context-menu .context-menu-item', { hasText: 'HTML' }).first().click()
  await page.waitForSelector('.tab.active:has-text(".html")')
  // No more typing: the type change alone must reach the backup.
  await sleep(1200)
  await crash(app)
  ;({ app, page, send } = await launch())
  await page.waitForSelector('.tab:has-text(".html")', { timeout: 5000 })
  await page.click('.tab:has-text(".html")')
  await sleep(300)
  check((await page.textContent('.statusbar .status-syntax')) === 'HTML', 'restored as HTML')
  check((await page.textContent('.cm-content')).includes('TYPE42'), 'with its text')
  check(!(await page.$('.editor-toolbar')), 'as a code document, without the Markdown toolbar')
  await send('new-file')
  const nextName = await page.textContent('.tab.active .tab-name')
  check(!(await page.$$eval('.tab .tab-name', (els, n) => els.filter((e) => e.textContent === n).length > 1, nextName)), `numbering continues past it: ${nextName}`)
  await crash(app)
  ;({ app, page, send } = await launch())

  console.log('▶ quitting with "Keep for Next Time" keeps everything for the next launch')
  const keptBefore = backups().length
  await page.click('.tab:has-text("README.md")')
  await send('view-split')
  await typeInEditor(page, '\n\n暂存的修改 STASH555')
  // Quit right away: the edit is still inside the backup debounce and must be written anyway.
  await answerWith(app, '暂存|Keep for Next Time')
  await quit(app)
  check(readFileSync(readme, 'utf8').indexOf('STASH555') === -1, 'README.md on disk not saved')
  check(backups().length === keptBefore + 1, `backups kept on disk (${keptBefore} → ${backups().length})`)
  ;({ app, page, send } = await launch())
  await page.waitForSelector('.tab.dirty:has-text("README.md")', { timeout: 5000 }).catch(() => null)
  const stashedTabs = await page.$$eval('.tab.dirty .tab-name', (els) => els.map((e) => e.textContent))
  check(stashedTabs.includes('README.md') && stashedTabs.length === keptBefore + 1, `restored unsaved: ${stashedTabs.join(', ')}`)
  await page.click('.tab:has-text("README.md")')
  await sleep(400)
  check((await previewText(page)).includes('STASH555'), 'README.md shows the stashed edit, including the last keystrokes')

  if (process.platform === 'darwin') {
    console.log('▶ macOS: closing the window with "Keep for Next Time" restores in the next window of the same run')
    await answerWith(app, '暂存|Keep for Next Time')
    const winClosed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await winClosed
    const prompts = await promptsShown(app)
    check(prompts.length === 1 && prompts[0].length === 4, `close prompt offers 4 choices: ${prompts[0]?.join(' / ')}`)
    const nextWin = app.waitForEvent('window')
    await app.evaluate(({ app: a }) => a.emit('activate'))
    page = await nextWin
    await page.waitForSelector('.app', { timeout: 20000 })
    await page.waitForSelector('.tab.dirty:has-text("README.md")', { timeout: 5000 }).catch(() => null)
    const again = await page.$$eval('.tab.dirty .tab-name', (els) => els.map((e) => e.textContent))
    check(again.includes('README.md') && again.length === keptBefore + 1, `new window restored: ${again.join(', ')}`)
  }

  console.log('▶ closing a single tab still offers only Save / Don\'t Save / Cancel')
  await answerWith(app, '取消|Cancel')
  await page.click('.tab:has-text("README.md")')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', 'close-tab'))
  await sleep(500)
  const tabPrompt = await promptsShown(app)
  check(tabPrompt.length === 1 && tabPrompt[0].length === 3, `tab close prompt: ${tabPrompt[0]?.join(' / ')}`)

  console.log('▶ quitting with "Don\'t Save" discards backups')
  await answerWith(app, '不保存|Don\'t Save')
  await quit(app)
  check(backups().length === 0, `no backups left after a normal quit (${backups().length})`)

  ;({ app, page, send } = await launch())
  await sleep(800)
  const restoredAgain = await page.$$eval('.tab.dirty', (els) => els.length)
  check(restoredAgain === 0, 'nothing restored after a deliberate discard')
  await crash(app)
} catch (err) {
  console.error(err)
  failures++
} finally {
  // Normally already crashed / quit; on an early failure this keeps the app from lingering.
  if (app) await closeApp(app)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll recovery checks passed')
process.exit(failures ? 1 : 0)
