/**
 * Pasting from spreadsheets / rich text: tables become Markdown tables instead of the picture
 * Excel puts on the clipboard; only real images are pasted as images.
 *
 *   npm run build && node tests/paste-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-paste-'))
const notes = join(work, 'notes')
cpSync(join(root, 'tests/fixtures/notes'), notes, { recursive: true })
writeFileSync(join(notes, 'code.ts'), 'const rows = []\n')

// What Excel puts on the clipboard for a 3×3 range (trimmed, but with its real quirks:
// Office namespaces, <style>, <col>, fragment comments, wrapped source lines, <br> in a cell).
const EXCEL_HTML = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=ProgId content=Excel.Sheet><meta name=Generator content="Microsoft Excel 15">
<style><!--table {mso-displayed-decimal-separator:"\\.";} .xl65 {mso-number-format:"\\#\\,\\#\\#0\\.00"; text-align:right;}--></style></head>
<body link="#0563C1" vlink="#954F72"><table border=0 cellpadding=0 cellspacing=0 width=300 style='border-collapse:collapse;width:225pt'>
<!--StartFragment-->
 <col width=100 span=3 style='width:75pt'>
 <tr height=20 style='height:15.0pt'>
  <td height=20 width=100 style='height:15.0pt;width:75pt'>产品</td>
  <td width=100 style='width:75pt'>销量</td>
  <td width=100 style='width:75pt'>备注</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 style='height:15.0pt'>苹果</td>
  <td class=xl65 align=right>1,234.00</td>
  <td>新鲜<br style='mso-data-placement:same-cell'>
  当季</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 style='height:15.0pt'>A|B</td>
  <td class=xl65 align=right>56.5</td>
  <td></td>
 </tr>
<!--EndFragment-->
</table></body></html>`
const EXCEL_TSV = '产品\t销量\t备注\r\n苹果\t1,234.00\t"新鲜\n当季"\r\nA|B\t56.5\t\r\n'
const SHEETS_HTML = `<meta charset="utf-8"><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/><col width="100"/></colgroup><tbody><tr><td rowspan="2">合并</td><td>x</td></tr><tr><td>y</td></tr></tbody></table>`
// 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

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
const send = (cmd) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)

/** Fire a paste event carrying the given clipboard formats (and optionally an image file). */
const paste = (selector, data, withImage = false) =>
  page.evaluate(
    ([sel, data, png]) => {
      const dt = new DataTransfer()
      for (const [type, value] of Object.entries(data)) dt.setData(type, value)
      if (png) dt.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
      const el = document.querySelector(sel)
      el.focus()
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    [selector, data, withImage ? PNG : null]
  )
const docOf = (scope) => page.evaluate((s) => document.querySelector(`${s} .cm-content`).cmTile.root.view.state.doc.toString(), scope)
const setDoc = (doc) =>
  page.evaluate((d) => {
    const view = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: d }, selection: { anchor: d.length } })
    view.focus()
  }, doc)
const toasts = () => page.$$eval('.toast', (els) => els.map((e) => e.textContent))
const MAIN = '.pane-editor .cm-content'

try {
  await page.waitForSelector('.tree-row')

  console.log('▶ Excel range into a new, unsaved document')
  await send('new-file')
  await send('view-split')
  await page.waitForSelector(MAIN)
  await sleep(200)
  await paste(MAIN, { 'text/html': EXCEL_HTML, 'text/plain': EXCEL_TSV }, true)
  await sleep(200)
  const doc = await docOf('.pane-editor')
  check(
    doc ===
      [
        '| 产品 |     销量 | 备注         |',
        '| ---- | -------: | ------------ |',
        '| 苹果 | 1,234.00 | 新鲜<br>当季 |',
        '| A\\|B |     56.5 |              |',
        ''
      ].join('\n'),
    'pasted as a Markdown table'
  )
  check(!(await toasts()).some((x) => x.includes('请先保存') || x.includes('save')), 'no "save before pasting an image" message')
  await page.waitForFunction(() => document.querySelectorAll('.markdown-body table tr').length === 3, null, { timeout: 5000 })
  const cells = await page.$$eval('.markdown-body table tr:nth-child(1) td', (tds) => tds.map((td) => td.innerHTML))
  check(cells[2] === '新鲜<br>当季', `line break inside a cell rendered (${cells[2]})`)
  const align = await page.$eval('.markdown-body table td:nth-child(2)', (td) => getComputedStyle(td).textAlign)
  check(align === 'right', 'numeric column right-aligned in the preview')
  await page.screenshot({ path: join(outDir, '60-paste-excel.png') })

  console.log('▶ in the middle of a paragraph, the table gets its own block')
  await setDoc('Intro text')
  await paste(MAIN, { 'text/html': EXCEL_HTML, 'text/plain': EXCEL_TSV }, true)
  check((await docOf('.pane-editor')).startsWith('Intro text\n\n| 产品 |'), 'blank line between paragraph and table')
  await setDoc('Above\nBelow')
  await page.evaluate(() => {
    const view = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: 5 } })
  })
  await paste(MAIN, { 'text/html': SHEETS_HTML, 'text/plain': '合并\tx\n\ty' })
  const sheets = await docOf('.pane-editor')
  check(sheets.includes('| 合并 | x   |\n| ---- | --- |\n|      | y   |\n\nBelow'), 'Google Sheets merged cell, blank line before the next paragraph')

  console.log('▶ one cell, rich text and real images')
  await setDoc('')
  await paste(MAIN, { 'text/html': '<table><tr><td>42.5</td></tr></table>', 'text/plain': '42.5\r\n' }, true)
  check((await docOf('.pane-editor')) === '42.5', 'a single cell pastes its value')
  await setDoc('')
  await paste(MAIN, { 'text/html': '<p class=MsoNormal><b>Word</b> paragraph</p>', 'text/plain': 'Word paragraph' }, true)
  check((await docOf('.pane-editor')) === 'Word paragraph', 'rich text from Word pastes as text, not its picture')
  await setDoc('')
  await paste(MAIN, { 'text/html': '<p>Intro</p><table><tr><td>a</td><td>b</td></tr></table><p>Outro</p>', 'text/plain': 'Intro\na\tb\nOutro' })
  check((await docOf('.pane-editor')) === 'Intro\na\tb\nOutro', 'a web page selection with text around a table stays plain text')
  await setDoc('')
  await paste(MAIN, { 'text/html': '<meta charset="utf-8"><img src="https://example.com/a.png">' }, true)
  await sleep(200)
  check((await toasts()).some((x) => x.includes('请先保存') || x.includes('save')), 'a copied picture is still pasted as an image (asks to save first)')

  console.log('▶ code files keep the raw text')
  await page.click('.sidebar-actions button[title="显示所有文件"], .sidebar-actions button[title="Show All Files"]')
  await page.click('.tree-row:has-text("code.ts")')
  await page.waitForFunction(() => document.querySelector('.tab.active .tab-name')?.textContent === 'code.ts')
  await sleep(300)
  await page.evaluate(() => {
    const view = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await paste(MAIN, { 'text/html': EXCEL_HTML, 'text/plain': EXCEL_TSV }, true)
  check((await docOf('.pane-editor')) === 'const rows = []\n' + EXCEL_TSV.replace(/\r\n/g, '\n'), 'tab-separated text pasted as is')

  console.log('▶ block editor in reading mode')
  await page.click('.tree-row:has-text("README.md")')
  await send('view-preview')
  await page.waitForSelector('.markdown-body h1')
  await page.locator('.markdown-body > p', { hasText: '端到端测试' }).dblclick()
  await page.waitForSelector('.mf-block-editor .cm-content')
  await page.evaluate(() => {
    const view = document.querySelector('.mf-block-editor .cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await paste('.mf-block-editor .cm-content', { 'text/html': EXCEL_HTML, 'text/plain': EXCEL_TSV }, true)
  const block = await docOf('.mf-block-editor')
  check(block.includes('\n\n| 产品 |     销量 | 备注         |'), 'table pasted into the inline block editor')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.mf-block-editor', { state: 'detached' })
  const rendered = await page
    .waitForFunction(() => document.querySelectorAll('.markdown-body table').length > 0, null, { timeout: 5000 })
    .then(() => true, () => false)
  check(rendered, 'table rendered after finishing the block edit')
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll paste checks passed')
process.exit(failures ? 1 : 0)
