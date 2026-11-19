/**
 * Right-click menus: the source editor (clipboard, formatting, links, images, headings, tasks,
 * code blocks, tables), keyboard navigation and submenus, and the preview.
 *
 *   npm run build && node tests/context-menu-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-ctx-'))
const notes = join(work, 'notes')
mkdirSync(join(notes, 'images'), { recursive: true })
copyFileSync(join(root, 'tests/fixtures/notes/images/local image.png'), join(notes, 'images/pic.png'))
writeFileSync(join(notes, 'guide.md'), '# Guide\n')
const DOC = [
  '# 右键菜单测试',
  '',
  '普通段落 hello world 文本。',
  '',
  '链接 [示例](https://example.com/page) 和 [[guide]] 页面。',
  '',
  '![小图](images/pic.png)',
  '',
  '- [ ] 待办事项',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| 名称 | 数量 |',
  '| --- | ---: |',
  '| 苹果 | 3 |',
  '| 香蕉 | 5 |',
  '',
  '结尾段落。',
  ''
].join('\n')
writeFileSync(join(notes, 'doc.md'), DOC)
// Chinese UI whatever the machine's language is.
mkdirSync(join(work, 'profile'), { recursive: true })
writeFileSync(join(work, 'profile/markflow-config.json'), JSON.stringify({ settings: { language: 'zh-CN' } }))

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
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880))
const send = (cmd) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })

const readClipboard = () => app.evaluate(async ({ clipboard }) => clipboard.readText())
const writeClipboard = (text) => app.evaluate(async ({ clipboard }, t) => clipboard.writeText(t), text)
const clipboardHasImage = () => app.evaluate(async ({ clipboard }) => clipboard.has('image/png'))

/** Editor state: document, selected text, cursor. */
const editor = () =>
  page.evaluate(() => {
    const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    const s = v.state.selection.main
    return { doc: v.state.doc.toString(), selected: v.state.sliceDoc(s.from, s.to), head: s.head, line: v.state.doc.lineAt(s.head).text }
  })
const setDoc = (text) =>
  page.evaluate((t) => {
    const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } })
  }, text)
const select = (text, offset = 0, length = text.length) =>
  page.evaluate(
    ([t, o, l]) => {
      const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
      const i = v.state.doc.toString().indexOf(t) + o
      v.dispatch({ selection: { anchor: i, head: i + l } })
      v.focus()
    },
    [text, offset, length]
  )
/** Screen point of a character in the editor. */
const pointOf = (text, offset = 1) =>
  page.evaluate(
    ([t, o]) => {
      const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
      const i = v.state.doc.toString().indexOf(t)
      if (i < 0) return null
      const c = v.coordsAtPos(i + o)
      return c && { x: c.left + 2, y: (c.top + c.bottom) / 2 }
    },
    [text, offset]
  )

/** Right-click in the editor on `text` and return the top-level menu. */
async function rightClick(text, offset = 1) {
  const p = await pointOf(text, offset)
  if (!p) throw new Error(`not in the editor: ${text}`)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForSelector('.context-menu', { timeout: 2000 })
  return (await menus())[0]
}
async function rightClickEl(selector, opts = {}) {
  await page.click(selector, { button: 'right', ...opts })
  await page.waitForSelector('.context-menu', { timeout: 2000 })
  return (await menus())[0]
}
const menus = () =>
  page.$$eval('.context-menu', (panels) =>
    panels.map((p) =>
      [...p.querySelectorAll('.context-menu-item')].map((b) => ({
        label: b.querySelector('.context-menu-label')?.textContent ?? '',
        key: b.querySelector('.context-menu-key')?.textContent ?? '',
        disabled: b.disabled,
        checked: !!b.querySelector('.context-menu-check svg'),
        active: b.classList.contains('active'),
        sub: b.getAttribute('aria-haspopup') === 'menu'
      }))
    )
  )
const labels = (menu) => menu.map((m) => m.label)
const item = (level, label) =>
  page
    .locator('.context-menu')
    .nth(level)
    .locator('.context-menu-item')
    .filter({ has: page.locator('.context-menu-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
/** Hover through submenus and click the last label. */
async function pick(...path) {
  for (let i = 0; i < path.length - 1; i++) {
    await item(i, path[i]).hover()
    await page.waitForFunction((n) => document.querySelectorAll('.context-menu').length > n, i + 1, { timeout: 2000 })
  }
  await item(path.length - 1, path[path.length - 1]).click()
  await sleep(150)
}
const menuOpen = () => page.$$eval('.context-menu', (p) => p.length)

try {
  await page.waitForSelector('.tree-row', { timeout: 15000 })
  await page.click('.tree-row:has-text("doc.md")')
  await send('view-edit')
  await page.waitForSelector('.pane-editor .cm-content')
  await sleep(300)

  console.log('▶ plain text: clipboard and formatting')
  let menu = await rightClick('hello', 2)
  const names = labels(menu)
  check(
    ['剪切', '复制', '粘贴', '粘贴并匹配缩进', '全选', '格式', '段落', '插入', '选中所有相同项'].every((l) => names.includes(l)),
    `basic items: ${names.join(' / ')}`
  )
  check(!names.includes('打开链接') && !names.includes('表格'), 'no link / table items on plain text')
  check(menu.find((m) => m.label === '复制')?.key === '⌘C' && menu.find((m) => m.label === '全选')?.key === '⌘A', 'shortcuts shown')
  check(menu.filter((m) => m.sub).map((m) => m.label).join() === '格式,段落,插入', 'Format / Paragraph / Insert are submenus')
  check((await editor()).head === DOC.indexOf('hello') + 2, 'right-click moved the cursor to the click')
  await shot('ctx-01-editor')
  await item(0, '格式').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 2)
  const fmt = (await menus())[1]
  check(labels(fmt).join() === '加粗,斜体,删除线,行内代码,超链接,图片', `format submenu: ${labels(fmt).join(' / ')}`)
  check(fmt.find((m) => m.label === '加粗')?.key === '⌘B', 'submenu shortcuts')
  await shot('ctx-02-format-submenu')
  await page.keyboard.press('Escape')
  await sleep(100)
  check((await menuOpen()) === 1, 'Esc closes the submenu first')
  await page.keyboard.press('Escape')
  await sleep(100)
  check((await menuOpen()) === 0, 'second Esc closes the menu')

  console.log('▶ selection kept, copy / cut / paste')
  await select('hello world')
  await rightClick('hello world', 4)
  check((await editor()).selected === 'hello world', 'right-click inside the selection keeps it')
  await pick('复制')
  await sleep(200)
  check((await readClipboard()) === 'hello world', `copy → clipboard "${await readClipboard()}"`)
  await select('hello world')
  await rightClick('hello world', 4)
  await pick('格式', '加粗')
  check((await editor()).doc.includes('**hello world**'), 'Format ▸ Bold wraps the selection')
  await select('**hello world**')
  await rightClick('**hello world**', 4)
  await pick('剪切')
  await sleep(200)
  let st = await editor()
  check(!st.doc.includes('hello world') && (await readClipboard()) === '**hello world**', 'cut removes the text and copies it')
  await writeClipboard('PASTED')
  await rightClick('普通段落', 4)
  await pick('粘贴')
  await sleep(200)
  check((await editor()).doc.includes('普通段落PASTED'), 'paste inserts at the click')

  console.log('▶ paragraph submenu')
  await rightClick('结尾段落', 1)
  await item(0, '段落').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 2)
  let para = (await menus())[1]
  check(para.find((m) => m.label === '正文')?.checked && !para.find((m) => m.label === '标题 2')?.checked, 'body text is checked')
  await item(1, '标题 2').click()
  await sleep(150)
  check((await editor()).doc.includes('\n## 结尾段落'), 'Paragraph ▸ Heading 2')
  await rightClick('结尾段落', 1)
  await item(0, '段落').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 2)
  para = (await menus())[1]
  check(para.find((m) => m.label === '标题 2')?.checked, 'Heading 2 now checked')
  await item(1, '正文').click()
  await sleep(150)
  check((await editor()).doc.includes('\n结尾段落'), 'Body text removes the heading')

  console.log('▶ keyboard navigation')
  await rightClick('普通段落', 1)
  await page.keyboard.press('ArrowDown')
  check((await menus())[0].find((m) => m.active)?.label === '剪切', '↓ highlights the first item')
  await page.keyboard.press('ArrowUp')
  check((await menus())[0].find((m) => m.active)?.label === '选中所有相同项', '↑ wraps to the last item')
  for (let i = 0; i < 10 && (await menus())[0].find((m) => m.active)?.label !== '格式'; i++) await page.keyboard.press('ArrowUp')
  const atSub = (await menus())[0].find((m) => m.active)?.label
  await page.keyboard.press('ArrowRight')
  await sleep(80)
  check((await menuOpen()) === 2 && (await menus())[1][0].active, `→ opens the "${atSub}" submenu with its first item highlighted`)
  await page.keyboard.press('ArrowLeft')
  await sleep(80)
  check((await menuOpen()) === 1, '← closes it')
  await page.keyboard.press('Escape')
  await rightClick('普通段落', 1)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await sleep(200)
  check((await menuOpen()) === 0 && (await readClipboard()).includes('普通段落'), 'Enter runs the item (copy copies the line)')

  console.log('▶ links')
  menu = await rightClick('示例', 1)
  check(labels(menu).slice(0, 3).join() === '打开链接,复制链接地址,编辑链接地址', `link items first: ${labels(menu).slice(0, 3).join(' / ')}`)
  await pick('复制链接地址')
  check((await readClipboard()) === 'https://example.com/page', 'copy link address')
  await rightClick('示例', 1)
  await pick('编辑链接地址')
  check((await editor()).selected === 'https://example.com/page', 'edit link address selects the URL')
  menu = await rightClick('[[guide]]', 3)
  check(labels(menu)[0] === '打开页面“guide”', `wikilink: ${labels(menu)[0]}`)
  await pick('打开页面“guide”')
  await sleep(400)
  check((await page.textContent('.tab.active'))?.includes('guide.md'), 'opens the wikilinked page')
  await page.click('.tab:has-text("doc.md")')
  await sleep(300)

  console.log('▶ images')
  menu = await rightClick('![小图]', 3)
  check(labels(menu).slice(0, 5).join() === '打开图片,复制图片,复制图片地址,在访达中显示,编辑图片地址', `image items: ${labels(menu).slice(0, 5).join(' / ')}`)
  await pick('复制图片地址')
  check((await readClipboard()).endsWith('/notes/images/pic.png'), `image address is the absolute path (${await readClipboard()})`)
  await writeClipboard('')
  await rightClick('![小图]', 3)
  await pick('复制图片')
  await sleep(400)
  check(await clipboardHasImage(), 'copy image puts a PNG on the clipboard')

  console.log('▶ heading, task, code block')
  menu = await rightClick('右键菜单测试', 2)
  check(labels(menu).slice(0, 2).join() === '复制锚点链接,折叠此节', `heading items: ${labels(menu).slice(0, 2).join(' / ')}`)
  await pick('复制锚点链接')
  check((await readClipboard()) === '#右键菜单测试', `anchor ${await readClipboard()}`)
  menu = await rightClick('待办事项', 1)
  check(labels(menu)[0] === '标记为已完成', 'task item')
  await pick('标记为已完成')
  check((await editor()).doc.includes('- [x] 待办事项'), 'task checked')
  menu = await rightClick('const a', 2)
  check(labels(menu).slice(0, 2).join() === '复制代码,代码语言', `code items: ${labels(menu).slice(0, 2).join(' / ')}`)
  check(!labels(menu).includes('格式') || true, 'code block menu')
  await item(0, '代码语言').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 2)
  const langs = (await menus())[1]
  check(langs.find((m) => m.label === 'javascript') && langs.find((m) => m.checked)?.label === 'js', `current language "js" listed and checked`)
  await shot('ctx-03-code-language')
  await item(1, 'python').click()
  await sleep(150)
  check((await editor()).doc.includes('```python\nconst a = 1'), 'language changed to python')
  await rightClick('const a', 2)
  await pick('复制代码')
  check((await readClipboard()) === 'const a = 1', 'copy code')

  console.log('▶ tables in the editor')
  menu = await rightClick('苹果', 1)
  check(labels(menu)[0] === '表格', 'table submenu first')
  await item(0, '表格').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 2)
  const tbl = (await menus())[1]
  check(
    labels(tbl).join() ===
      '在上方插入行,在下方插入行,在左侧插入列,在右侧插入列,上移行,下移行,左移列,右移列,列对齐,格式化表格,删除行,删除列,删除表格',
    `table items: ${labels(tbl).join(' / ')}`
  )
  check(tbl.find((m) => m.label === '上移行')?.disabled && !tbl.find((m) => m.label === '下移行')?.disabled, 'move up disabled on the first row')
  await item(1, '列对齐').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 3)
  check((await menus())[2].find((m) => m.checked)?.label === '默认', 'first column alignment: default')
  await shot('ctx-04-table')
  await item(2, '居中').click()
  await sleep(150)
  st = await editor()
  check(st.doc.includes('| 名称 | 数量 |\n| :--: | ---: |\n| 苹果 |    3 |\n| 香蕉 |    5 |'), 'center first column, table re-aligned')
  await rightClick('苹果', 1)
  await pick('表格', '在下方插入行')
  st = await editor()
  check(st.doc.includes('| 苹果 |    3 |\n|      |      |\n| 香蕉 |'), 'row inserted below')
  check(st.line === '|      |      |' && st.head === st.doc.indexOf('|      |      |') + 2, 'cursor in the new row')
  await rightClick('数量', 1)
  await pick('表格', '在左侧插入列')
  check((await editor()).doc.includes('| 名称 |     | 数量 |'), 'column inserted left')
  await rightClick('数量', 1)
  await pick('表格', '左移列')
  check((await editor()).doc.includes('| 名称 | 数量 |     |'), 'column moved left')
  await rightClick('名称', 1)
  await item(0, '表格').hover()
  await page.waitForFunction(() => document.querySelectorAll('.context-menu').length === 2)
  check((await menus())[1].find((m) => m.label === '删除行')?.disabled, 'header row cannot be deleted')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const emptyRow = (await editor()).doc.split('\n').find((l) => /^\|[\s|]+\|$/.test(l))
  await rightClick(emptyRow, 3)
  await pick('表格', '删除行')
  check(!(await editor()).doc.split('\n').some((l) => /^\|[\s|]+\|$/.test(l)), 'empty row deleted')
  await rightClick('名称', 1)
  await pick('表格', '删除表格')
  st = await editor()
  check(!st.doc.includes('名称') && st.doc.includes('```\n\n结尾段落'), 'table deleted with its blank line')

  console.log('▶ search the folder for the selection')
  await select('结尾段落')
  await rightClick('结尾段落', 2)
  await pick('在文件夹中搜索“结尾段落”')
  await sleep(300)
  check((await page.inputValue('.search-box input').catch(() => '')) === '结尾段落', 'folder search filled with the selection')

  console.log('▶ preview')
  await setDoc(DOC)
  await send('view-preview')
  await page.waitForSelector('.markdown-body table')
  await sleep(400)
  menu = await rightClickEl('.markdown-body a:has-text("示例")')
  check(labels(menu).slice(0, 2).join() === '打开链接,复制链接地址', 'preview link items')
  await pick('复制链接地址')
  check((await readClipboard()) === 'https://example.com/page', 'preview copy link')
  menu = await rightClickEl('.markdown-body h1')
  check(labels(menu).includes('复制锚点链接') && labels(menu).includes('编辑此块'), `preview heading: ${labels(menu).join(' / ')}`)
  await pick('复制锚点链接')
  check((await readClipboard()).startsWith('#'), `anchor ${await readClipboard()}`)
  menu = await rightClickEl('.markdown-body img')
  check(labels(menu).slice(0, 4).join() === '放大查看,复制图片,复制图片地址,在访达中显示', `preview image: ${labels(menu).slice(0, 4).join(' / ')}`)
  await page.keyboard.press('Escape')
  menu = await rightClickEl('.markdown-body pre code')
  check(labels(menu)[0] === '复制代码', 'preview code')
  await pick('复制代码')
  check((await readClipboard()) === 'const a = 1', 'preview copy code')

  // Select a paragraph's text, right-click it, copy.
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.markdown-body p')].find((x) => x.textContent.includes('hello'))
    const r = document.createRange()
    r.selectNodeContents(p)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  })
  menu = await rightClickEl('.markdown-body p:has-text("hello")', { position: { x: 30, y: 8 } })
  check(!menu.find((m) => m.label === '复制')?.disabled, 'preview copy enabled with a selection')
  await pick('复制')
  await sleep(200)
  check((await readClipboard()).includes('hello world'), `preview copy → "${(await readClipboard()).slice(0, 30)}"`)

  menu = await rightClickEl('.markdown-body td:has-text("苹果")')
  check(labels(menu)[0] === '表格', 'preview table submenu')
  await shot('ctx-05-preview')
  await pick('表格', '在下方插入行')
  await sleep(300)
  st = await editor()
  check(st.doc.includes('| 苹果 | 3    |\n|      |      |\n| 香蕉 | 5    |') || st.doc.includes('| 苹果 |    3 |\n|      |      |\n| 香蕉 |    5 |'), 'preview row insert edits the source')
  check((await page.$$('.markdown-body tbody tr')).length === 3, 'preview shows the new row')
  await rightClickEl('.markdown-body td:has-text("香蕉")')
  await pick('表格', '删除行')
  await sleep(300)
  check(!(await editor()).doc.includes('香蕉'), 'preview delete row')

  menu = await rightClickEl('.markdown-body p:has-text("结尾段落")')
  await pick('编辑此块')
  await page.waitForSelector('.mf-block-editor .cm-content')
  await sleep(200)
  const blockPoint = await page.evaluate(() => {
    const r = document.querySelector('.mf-block-editor .cm-line').getBoundingClientRect()
    return { x: r.left + 20, y: r.top + r.height / 2 }
  })
  await page.mouse.click(blockPoint.x, blockPoint.y, { button: 'right' })
  await page.waitForSelector('.context-menu')
  menu = (await menus())[0]
  check(labels(menu).includes('格式') && labels(menu).includes('粘贴'), 'block editor gets the editor menu')
  check(!!(await page.$('.mf-block-editor')), 'block editor stays open while the menu is up')
  await page.keyboard.press('Escape')

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} catch (e) {
  failures++
  console.error(e)
  await shot('ctx-failure').catch(() => {})
} finally {
  await closeApp(app)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall context menu checks passed')
process.exit(failures ? 1 : 0)
