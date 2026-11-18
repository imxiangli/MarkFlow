/**
 * Reading-mode features: in-place block editing, per-block Markdown source, zoom viewer.
 *
 *   npm run build && node tests/reading-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-reading-'))
const notes = join(work, 'notes')
cpSync(join(root, 'tests/fixtures/notes'), notes, { recursive: true })
const readme = join(notes, 'README.md')

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, notes],
  env: { ...process.env, MARKFLOW_USER_DATA: join(work, 'profile') }
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880))
const send = (cmd) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const body = () => page.textContent('.markdown-body')

try {
  await page.waitForSelector('.tree-row')
  await page.click('.tree-row:has-text("README.md")')
  await send('view-preview')
  await page.waitForSelector('.markdown-body h1')

  console.log('▶ double-click a paragraph to edit it in place')
  const para = page.locator('.markdown-body > p', { hasText: '端到端测试' })
  await para.dblclick()
  await page.waitForSelector('.mf-block-editor .cm-content')
  const src = await page.textContent('.mf-block-editor .cm-content')
  check(src.includes('**MarkFlow**'), `editor shows the block's Markdown source: "${src.trim()}"`)
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.type('（阅读模式下修改）')
  await shot('20-block-editing')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.mf-block-editor', { state: 'detached' })
  const t0 = Date.now()
  const updated = await page
    .waitForFunction(() => document.querySelector('.markdown-body')?.textContent?.includes('（阅读模式下修改）'), null, { timeout: 3000 })
    .then(() => true, () => false)
  check(updated, `rendered paragraph updated after Esc (${Date.now() - t0} ms)`)
  check(!!(await page.$('.tab.active.dirty')), 'document marked as modified')
  await send('save')
  await sleep(400)
  check(readFileSync(readme, 'utf8').includes('**MarkFlow** 端到端测试使用的示例文件夹。（阅读模式下修改）'), 'saved to disk with Markdown intact')

  console.log('▶ cancel discards the change')
  await page.locator('.markdown-body > h1').dblclick()
  await page.waitForSelector('.mf-block-editor .cm-content')
  await page.keyboard.type('不应保存')
  await page.click('.mf-block-editor-bar button:has-text("取消"), .mf-block-editor-bar button:has-text("Cancel")')
  await sleep(300)
  check(!(await body()).includes('不应保存'), 'cancelled edit not applied')

  console.log('▶ add a new block at the end')
  await page.click('.preview-add-block')
  await page.waitForSelector('.mf-block-editor .cm-content')
  await page.keyboard.type('## 新增的块\n\n阅读模式下新增的内容')
  await page.keyboard.press(`${mod}+Enter`)
  await page.waitForSelector('.markdown-body h2:has-text("新增的块")')
  check(true, 'new heading rendered at the end')

  console.log('▶ undo works in reading mode')
  await send('undo')
  await sleep(400)
  check(!(await page.$('.markdown-body h2:has-text("新增的块")')), 'undo removed the added block')
  await send('redo')
  await sleep(400)
  check(!!(await page.$('.markdown-body h2:has-text("新增的块")')), 'redo restored it')

  console.log('▶ show one block as Markdown source')
  await page.hover('.markdown-body > h1')
  await page.waitForSelector('.block-tools')
  await shot('21-block-tools')
  await page.click('.block-tools button[title*="源码"], .block-tools button[title*="source"]')
  await page.waitForSelector('.mf-block-source')
  const sourceText = await page.textContent('.mf-block-source pre')
  check(sourceText.trim() === '# 测试笔记', `source view shows "${sourceText.trim()}"`)
  check(!(await page.isVisible('.markdown-body > h1')), 'rendered heading hidden while showing source')
  await shot('22-block-source')
  const htmlOut = join(work, 'export.html')
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, htmlOut)
  await send('export-html')
  await sleep(1200)
  const exported = existsSync(htmlOut) ? readFileSync(htmlOut, 'utf8') : ''
  check(exported.includes('测试笔记</h1>') && !exported.includes('class="mf-block-source"'), 'HTML export uses the rendered block, not the source view')
  await page.click('.mf-block-source-exit')
  await page.waitForSelector('.mf-block-source', { state: 'detached' })
  check(await page.isVisible('.markdown-body > h1'), 'back to rendered view')

  console.log('▶ image zoom')
  await page.click('.markdown-body img')
  await page.waitForSelector('.zoom-viewer .zoom-content img')
  check(true, 'image opens in the zoom viewer')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.zoom-viewer', { state: 'detached' })

  console.log('▶ diagram zoom')
  await page.click('.tree-row:has-text("guide.md")')
  await page.waitForFunction(() => document.querySelectorAll('.mf-diagram[data-kind="mermaid"] svg').length >= 1, null, { timeout: 30000 })
  await page.$eval('.mf-diagram[data-kind="mermaid"]', (el) => el.scrollIntoView({ block: 'center' }))
  await sleep(300)
  await page.click('.mf-diagram[data-kind="mermaid"] .mf-diagram-svg')
  await page.waitForSelector('.zoom-viewer .zoom-svg svg')
  await sleep(300)
  const level1 = await page.textContent('.zoom-level')
  await page.keyboard.press('+')
  await page.keyboard.press('+')
  await sleep(200)
  const level2 = await page.textContent('.zoom-level')
  check(parseInt(level2) > parseInt(level1), `zoom in: ${level1} → ${level2}`)
  await page.mouse.move(600, 400)
  await page.mouse.down()
  await page.mouse.move(700, 450, { steps: 5 })
  await page.mouse.up()
  await shot('23-zoom-viewer')
  const svgOut = join(work, 'diagram.svg')
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, svgOut)
  await page.click('.zoom-toolbar button[title*="SVG"]')
  await sleep(500)
  const svgText = existsSync(svgOut) ? readFileSync(svgOut, 'utf8') : ''
  check(svgText.startsWith('<?xml') && svgText.includes('<svg') && svgText.includes('xmlns="http://www.w3.org/2000/svg"'), `exported SVG (${svgText.length} bytes)`)
  await page.keyboard.press('0')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.zoom-viewer', { state: 'detached' })

  console.log('▶ graphviz zoom from the block toolbar')
  await page.$eval('.mf-diagram[data-kind="graphviz"]', (el) => el.scrollIntoView({ block: 'center' }))
  await sleep(300)
  await page.hover('.mf-diagram[data-kind="graphviz"]')
  await page.click('.block-tools button[title*="放大"], .block-tools button[title*="Zoom"]')
  await page.waitForSelector('.zoom-viewer .zoom-svg svg')
  check(true, 'graphviz opens from the toolbar zoom button')
  await page.keyboard.press('Escape')
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  rmSync(work, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll reading-mode checks passed')
process.exit(failures ? 1 : 0)
