/**
 * Any file can be opened: code with syntax highlighting, text in legacy encodings / CRLF /
 * UTF-16 (kept when saving), and binary files shown as a file-type icon. New documents can be
 * given any of those types.
 *
 *   npm run build && node tests/files-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const iconv = require('iconv-lite')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-files-'))
const notes = join(work, 'notes')
cpSync(join(root, 'tests/fixtures/notes'), notes, { recursive: true })

// ---- fixtures
const f = (name) => join(notes, 'files', name)
mkdirSync(join(notes, 'files'), { recursive: true })
writeFileSync(f('app.ts'), 'interface User {\n  name: string\n}\n\nexport function greet(user: User): string {\n  return `Hello ${user.name}` // MARK_TS\n}\n')
writeFileSync(f('Dockerfile'), 'FROM node:22\nRUN npm ci\nCMD ["node", "index.js"]\n')
writeFileSync(f('settings.conf'), '# comment\nport = 8080\nhost = localhost\n')
writeFileSync(f('tool'), '#!/usr/bin/env python3\nprint("hi")\n')
writeFileSync(f('gbk.txt'), iconv.encode('中文内容：GB18030 编码\n第二行\n', 'gb18030'))
writeFileSync(f('latin.txt'), iconv.encode('café crème\n', 'windows-1252'))
writeFileSync(f('crlf.txt'), 'line one\r\nline two\r\n')
writeFileSync(f('utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF-16 文本\n', 'utf16le')]))
writeFileSync(f('blob.xyz'), Buffer.from([0x4d, 0x46, 0x00, 0x01, 0x02, 0x00, 0xff, 0x10, 0x00, 0x00, 0x41, 0x42]))
writeFileSync(f('archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]))

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, notes],
  env: { ...process.env, MARKFLOW_USER_DATA: join(work, 'profile') }
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880))
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const send = (cmd) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)
const open = (path) =>
  app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('mf:open-paths', [p]), path)
const status = () => page.$$eval('.statusbar .status-btn', (els) => els.map((e) => e.textContent.trim()))
const activeName = () => page.textContent('.tab.active .tab-name')
const editorText = () =>
  page.evaluate(() => document.querySelector('.pane-editor .cm-content').cmTile.root.view.state.doc.toString())
async function openAndWait(path, name) {
  await open(path)
  await page.waitForFunction((n) => document.querySelector('.tab.active .tab-name')?.textContent === n, name, { timeout: 5000 })
  await sleep(250)
}
async function menuItem(label) {
  await page.click(`.context-menu .context-menu-item:text-is("${label}")`)
}

try {
  await page.waitForSelector('.tree-row')

  console.log('▶ show all files from the file tree')
  check(!(await page.$('.tree-row:has-text("files")')), 'non-Markdown folder hidden by default')
  await page.click('.sidebar-actions button[title="显示所有文件"], .sidebar-actions button[title="Show All Files"]')
  await page.waitForSelector('.tree-row:has-text("files")')
  await page.click('.tree-row:has-text("files")')
  await page.waitForSelector('.tree-row:has-text("app.ts")')
  check(true, 'files/ appears with its code files')

  console.log('▶ code file with syntax highlighting')
  await page.click('.tree-row:has-text("app.ts")')
  await page.waitForFunction(() => document.querySelector('.tab.active .tab-name')?.textContent === 'app.ts')
  await page.waitForFunction(
    () => document.querySelectorAll('.pane-editor .cm-line span[class]').length > 5,
    null,
    { timeout: 5000 }
  )
  const tokenColors = await page.$$eval('.pane-editor .cm-line span[class]', (els) => new Set(els.map((e) => getComputedStyle(e).color)).size)
  check(tokenColors >= 3, `TypeScript tokens highlighted in ${tokenColors} colours`)
  check(!(await page.$('.editor-toolbar')), 'no Markdown toolbar for code files')
  let st = await status()
  check(st.join('|') === 'UTF-8|LF|TypeScript', `status bar: ${st.join(' · ')}`)
  await shot('50-code-file')

  console.log('▶ Markdown keys do nothing in code, Sublime keys still work')
  await page.click('.pane-editor .cm-content')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B')
  check(!(await editorText()).includes('**'), '⌘B does not insert ** into code')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+/' : 'Control+/')
  check((await editorText()).split('\n')[0].startsWith('// ') || (await editorText()).includes('/*'), 'toggle comment uses the language comment syntax')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')

  console.log('▶ syntax from file names and shebangs')
  for (const [name, lang] of [
    ['Dockerfile', 'Dockerfile'],
    ['settings.conf', 'Properties files'],
    ['tool', 'Python']
  ]) {
    await openAndWait(f(name), name)
    st = await status()
    check(st[2] === lang, `${name} → ${st[2]}`)
  }

  console.log('▶ Set Syntax from the status bar / command palette')
  await page.click('.statusbar .status-syntax')
  await page.waitForSelector('.palette input')
  await page.keyboard.type('ruby')
  await page.waitForSelector('.palette .qo-item')
  check((await page.textContent('.palette .qo-item.active .qo-label')).includes('Ruby'), 'palette offers "Set Syntax: Ruby"')
  await page.keyboard.press('Enter')
  await sleep(200)
  check((await status())[2] === 'Ruby', 'syntax switched to Ruby')

  console.log('▶ legacy encodings are detected and kept')
  await openAndWait(f('gbk.txt'), 'gbk.txt')
  st = await status()
  check(st[0] === 'GB18030', `gbk.txt detected as ${st[0]}`)
  check((await editorText()).startsWith('中文内容：GB18030 编码'), 'GB18030 text decoded correctly')
  await page.click('.pane-editor .cm-content')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type('新增一行')
  await send('save')
  await sleep(400)
  const gbkOnDisk = readFileSync(f('gbk.txt'))
  check(iconv.decode(gbkOnDisk, 'gb18030').endsWith('第二行\n新增一行') && !gbkOnDisk.includes(Buffer.from('新增', 'utf8')), 'saved back as GB18030')

  await openAndWait(f('latin.txt'), 'latin.txt')
  st = await status()
  check(st[0] === 'Windows-1252' && (await editorText()) === 'café crème\n', `latin.txt detected as ${st[0]}`)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await page.click('.pane-editor .cm-content')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type('中文')
  await send('save')
  await sleep(500)
  check(readFileSync(f('latin.txt'), 'utf8') === 'café crème\n中文', 'characters Windows-1252 cannot hold → saved as UTF-8 after asking')
  check((await status())[0] === 'UTF-8', 'status bar now shows UTF-8')

  console.log('▶ reopen with another encoding')
  await openAndWait(f('gbk.txt'), 'gbk.txt')
  await page.click('.statusbar .status-btn >> nth=0')
  await page.waitForSelector('.context-menu')
  await shot('51-encoding-menu')
  await page.locator('.context-menu .context-menu-item', { hasText: 'Windows-1252' }).first().click()
  await sleep(300)
  check((await status())[0] === 'Windows-1252' && !(await editorText()).startsWith('中文'), 'reopened as Windows-1252 (mojibake, as expected)')
  await page.click('.statusbar .status-btn >> nth=0')
  await page.locator('.context-menu .context-menu-item', { hasText: 'GB18030' }).first().click()
  await sleep(300)
  check((await editorText()).startsWith('中文内容'), 'reopened as GB18030 again')

  console.log('▶ CRLF and UTF-16 are kept')
  await openAndWait(f('crlf.txt'), 'crlf.txt')
  check((await status())[1] === 'CRLF', 'crlf.txt shows CRLF')
  await page.click('.pane-editor .cm-content')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type('line three\n')
  await send('save')
  await sleep(400)
  check(readFileSync(f('crlf.txt'), 'utf8') === 'line one\r\nline two\r\nline three\r\n', 'saved with CRLF line endings')
  await page.click('.statusbar .status-btn >> nth=1')
  await menuItem(' LF')
  await sleep(100)
  check(!!(await page.$('.tab.active.dirty')), 'switching to LF marks the document modified')
  await send('save')
  await sleep(400)
  check(readFileSync(f('crlf.txt'), 'utf8') === 'line one\nline two\nline three\n', 'saved with LF after switching')

  await openAndWait(f('utf16.txt'), 'utf16.txt')
  check((await status())[0] === 'UTF-16 LE' && (await editorText()) === 'UTF-16 文本\n', 'UTF-16 LE with BOM decoded')

  console.log('▶ binary files show their type icon')
  await openAndWait(f('archive.zip'), 'archive.zip')
  await page.waitForSelector('.binary-viewer')
  await page.waitForFunction(() => !!document.querySelector('.binary-icon img, .binary-icon svg'))
  const meta = await page.textContent('.binary-meta')
  check(/ZIP/.test(meta), `type line: ${meta}`)
  check(!(await page.$('.binary-actions button:has-text("仍以文本方式打开"), .binary-actions button:has-text("Open as Text")')), 'known binary formats cannot be opened as text')
  check(!(await page.$('.pane-editor')) || !(await page.isVisible('.pane-editor')), 'editor hidden for binary files')
  await shot('52-binary-file')

  await openAndWait(f('blob.xyz'), 'blob.xyz')
  await page.waitForSelector('.binary-viewer')
  check(true, 'unknown extension with NUL bytes → binary view')
  await page.click('.binary-actions button:has-text("仍以文本方式打开"), .binary-actions button:has-text("Open as Text")')
  await page.waitForSelector('.pane-editor .cm-content')
  await sleep(200)
  check((await editorText()).startsWith('MF'), 'open as text anyway shows the bytes in the editor')

  console.log('▶ new documents: choose the type')
  const syntaxLabel = () => page.textContent('.statusbar .status-syntax')
  const nameEnds = (ext) =>
    page.waitForFunction((x) => document.querySelector('.tab.active .tab-name')?.textContent.endsWith(x), ext, { timeout: 5000 })
  const pickType = async (label) => {
    await page.click('.statusbar .status-syntax')
    await page.waitForSelector('.context-menu')
    await page.locator('.context-menu .context-menu-item', { hasText: label }).first().click()
  }
  await send('new-file')
  await nameEnds('.md')
  check((await syntaxLabel()) === 'Markdown', 'a new document starts as Markdown')
  await page.click('.pane-editor .cm-content')
  // Markdown closes the tag by itself, as HTML does.
  await page.keyboard.type('<h1 class="title">hello')
  const typed = await editorText()
  await page.click('.statusbar .status-syntax')
  await page.waitForSelector('.context-menu')
  await shot('53-new-document-type')
  await page.locator('.context-menu .context-menu-item', { hasText: 'HTML' }).first().click()
  await nameEnds('.html')
  check((await syntaxLabel()) === 'HTML', 'status bar shows HTML')
  check((await editorText()) === typed, 'text kept')
  check(!(await page.$('.editor-toolbar')) && !(await page.isVisible('.markdown-body').catch(() => false)), 'no Markdown toolbar or preview')
  const htmlColored = await page
    .waitForFunction(() => new Set([...document.querySelectorAll('.pane-editor .cm-line span[class]')].map((e) => getComputedStyle(e).color)).size >= 2, null, { timeout: 5000 })
    .then(() => true, () => false)
  check(htmlColored, 'highlighted as HTML')
  await page.waitForTimeout(100)
  check(await page.evaluate(() => document.querySelector('.pane-editor .cm-content').contains(document.activeElement) || document.activeElement === document.querySelector('.pane-editor .cm-content')), 'focus back in the editor')
  await send('undo')
  await sleep(100)
  check((await editorText()) !== typed, 'undo history survives the change')
  await send('redo')
  await sleep(100)
  check((await editorText()) === typed, 'and redo')

  await pickType('Markdown')
  await nameEnds('.md')
  await page.waitForSelector('.editor-toolbar')
  check(true, 'back to Markdown: toolbar returns')
  await page.locator('.statusbar .status-syntax').click()
  await page.locator('.context-menu .context-menu-item').first().click()
  await nameEnds('.txt')
  check(/^(纯文本|Plain Text)$/.test(await syntaxLabel()), 'plain text → .txt')
  await page.keyboard.type('\n#!/bin/sh')
  await sleep(150)
  check(/^(纯文本|Plain Text)$/.test(await syntaxLabel()), 'plain text stays plain whatever is typed')
  await pickType('Python')
  await nameEnds('.py')

  await pickType(/其他类型|Other Types/)
  await page.waitForSelector('.palette input')
  const firstRows = await page.$$eval('.palette .qo-item .qo-label', (els) => els.slice(0, 3).map((e) => e.textContent))
  check(/纯文本|Plain Text/.test(firstRows[0]) && firstRows[1].includes('Markdown'), `other types list starts with the common ones: ${firstRows.join(' / ')}`)
  await shot('54-new-document-other-types')
  await page.keyboard.type('rust')
  await page.waitForFunction(() => document.querySelector('.palette .qo-item.active .qo-label')?.textContent.includes('Rust'))
  check((await page.textContent('.palette .qo-item.active .qo-detail')) === '.rs', 'palette shows the extension')
  await page.keyboard.press('Enter')
  await nameEnds('.rs')

  await page.click('.tab.active', { button: 'right' })
  await page.locator('.context-menu .context-menu-item', { hasText: /设置文档类型|Set Document Type/ }).click()
  await page.waitForSelector('.palette input')
  await page.keyboard.type('javascript')
  await page.waitForFunction(() => document.querySelector('.palette .qo-item.active .qo-label')?.textContent.includes('JavaScript'))
  await page.keyboard.press('Enter')
  await nameEnds('.js')
  check((await syntaxLabel()) === 'JavaScript', 'type set from the tab menu')

  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async (_win, opts) => {
      globalThis.__saveOptions = opts
      return { canceled: false, filePath: target }
    }
  }, f('saved.js'))
  await send('save')
  await page.waitForFunction(() => document.querySelector('.tab.active .tab-name')?.textContent === 'saved.js', null, { timeout: 5000 })
  const saveOptions = await app.evaluate(() => globalThis.__saveOptions)
  check(/-\d+\.js$/.test(saveOptions.defaultPath), `save dialog proposes ${saveOptions.defaultPath.split(/[\\/]/).pop()}`)
  check(saveOptions.filters[0].extensions[0] === 'js', 'save dialog filters on .js first')
  check(readFileSync(f('saved.js'), 'utf8').startsWith(typed), 'saved to disk')
  check((await syntaxLabel()) === 'JavaScript', 'still JavaScript once saved')
  await page.click('.statusbar .status-syntax')
  await page.waitForSelector('.palette input')
  check(!(await page.$('.context-menu')), 'a saved file has a syntax, not a type: palette instead of the type menu')
  await page.keyboard.press('Escape')

  // The file name wins over the chosen type.
  await send('new-file')
  await nameEnds('.md')
  await pickType('HTML')
  await nameEnds('.html')
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, f('notes.md'))
  await page.click('.pane-editor .cm-content')
  await page.keyboard.type('# heading')
  await send('save')
  await page.waitForFunction(() => document.querySelector('.tab.active .tab-name')?.textContent === 'notes.md', null, { timeout: 5000 })
  await page.waitForSelector('.editor-toolbar')
  check(true, 'saved as .md → a Markdown document')

  console.log('▶ the guide and files on disk have no type to set')
  await openAndWait(f('../README.md'), 'README.md')
  check(!(await page.$('.statusbar .status-syntax')), 'a Markdown file just says Markdown')
  await send('markdown-guide')
  await sleep(300)
  check(!(await page.$('.statusbar .status-syntax')), 'neither does the built-in guide')

  console.log('▶ folder search includes text files when all files are shown')
  await send('search-in-folder')
  await page.fill('.search-box input', 'MARK_TS')
  const found = await page
    .waitForFunction(() => document.querySelector('.search-panel')?.textContent?.includes('app.ts'), null, { timeout: 5000 })
    .then(() => true, () => false)
  check(found, 'search finds a match in app.ts')
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  await sleep(200)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll file-type checks passed')
process.exit(failures ? 1 : 0)
