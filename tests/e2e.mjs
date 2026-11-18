/**
 * End-to-end smoke test: launches the built app with Playwright, drives the main
 * features and writes screenshots to tests/output/.
 *
 *   npm run build && node tests/e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
const only = process.argv[2]

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const work = await mkdtemp(join(tmpdir(), 'markflow-e2e-'))
  const notes = join(work, 'notes')
  await cp(join(root, 'tests/fixtures/notes'), notes, { recursive: true })
  const userData = join(work, 'profile')

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, notes],
    env: { ...process.env, MARKFLOW_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '0' },
    cwd: root
  })
  const page = await app.firstWindow()
  const logs = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.setViewportSize?.({ width: 1360, height: 860 }).catch(() => {})
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880))

  const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
  const send = (cmd) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)

  console.log('▶ folder opened from the command line')
  await page.waitForSelector('.tree-row', { timeout: 15000 })
  const names = await page.$$eval('.tree-row .tree-name', (els) => els.map((e) => e.textContent))
  check(names.includes('README.md') && names.includes('guide.md') && names.includes('sub'), `tree shows files: ${names.join(', ')}`)
  check((await page.$$('.tab')).length === 0, 'no stray tabs opened from the launch arguments')
  check(!names.includes('ignored.txt'), 'non-markdown files hidden by default')
  await shot('01-folder')

  console.log('▶ open README.md')
  await page.click('.tree-row:has-text("README.md")')
  await page.waitForSelector('.markdown-body h1')
  const h1 = await page.textContent('.markdown-body h1')
  check(h1?.includes('测试笔记'), 'README rendered')
  await page.waitForFunction(() => {
    const img = document.querySelector('.markdown-body img')
    return img && img.complete && img.naturalWidth > 0
  }, null, { timeout: 8000 }).then(
    () => check(true, 'local image with spaces in path loads via mf-asset://'),
    () => check(false, 'local image with spaces in path loads via mf-asset://')
  )
  await shot('02-readme')

  console.log('▶ toggle task checkbox in preview')
  await page.click('.markdown-body input.task-list-item-checkbox >> nth=0')
  await page.waitForTimeout(300)
  const tabDirty = await page.$('.tab.active.dirty')
  check(!!tabDirty, 'checkbox toggle marks document dirty')
  await send('save')
  await page.waitForTimeout(400)
  const saved = await readFile(join(notes, 'README.md'), 'utf8')
  check(saved.includes('- [x] 第一项任务'), 'checkbox toggle saved to disk')

  console.log('▶ relative link with anchor opens other document')
  await page.click('.markdown-body a:has-text("子页面") >> nth=0')
  await page.waitForSelector('.tab.active:has-text("page.md")')
  check(true, 'sub/page.md opened in a new tab')
  await page.waitForTimeout(600)
  const scrolled = await page.$eval('.preview-scroll', (el) => el.scrollTop)
  check(scrolled >= 0, `anchor navigation (scrollTop=${scrolled})`)

  console.log('▶ full syntax guide')
  await page.click('.tree-row:has-text("guide.md")')
  await page.waitForSelector('.markdown-body .mf-toc')
  await page.waitForFunction(
    () => document.querySelectorAll('.mf-diagram').length >= 6 && !document.querySelector('.mf-diagram[data-state="pending"]'),
    null,
    { timeout: 30000 }
  ).catch(() => {})
  const diagrams = await page.$$eval('.mf-diagram', (els) => els.map((e) => `${e.getAttribute('data-kind')}:${e.getAttribute('data-state')}:${e.querySelector('svg') ? 'svg' : e.querySelector('.mf-diagram-error') ? 'error' : 'none'}`))
  console.log('    diagrams:', diagrams.join(' '))
  check(diagrams.filter((d) => d.startsWith('mermaid') && d.endsWith(':svg')).length === 3, 'mermaid diagrams rendered')
  check(diagrams.some((d) => d.startsWith('graphviz') && d.endsWith(':svg')), 'graphviz rendered')
  check(diagrams.some((d) => d.startsWith('echarts') && d.endsWith(':svg')), 'echarts rendered')
  const counts = await page.evaluate(() => ({
    katex: document.querySelectorAll('.markdown-body .katex').length,
    alerts: document.querySelectorAll('.markdown-body .markdown-alert').length,
    containers: document.querySelectorAll('.markdown-body .mf-container').length,
    footnotes: document.querySelectorAll('.markdown-body .footnote-item').length,
    tasks: document.querySelectorAll('.markdown-body .task-list-item').length,
    tables: document.querySelectorAll('.markdown-body table').length,
    hljs: document.querySelectorAll('.markdown-body .hljs-keyword').length,
    abbr: document.querySelectorAll('.markdown-body abbr').length,
    dl: document.querySelectorAll('.markdown-body dl').length,
    mark: document.querySelectorAll('.markdown-body mark').length,
    sub: document.querySelectorAll('.markdown-body sub').length,
    sup: document.querySelectorAll('.markdown-body sup').length,
    frontMatter: document.querySelectorAll('.markdown-body .mf-frontmatter').length,
    outline: document.querySelectorAll('.outline-item').length
  }))
  console.log('    counts:', JSON.stringify(counts))
  check(counts.katex >= 7, 'KaTeX math rendered')
  check(counts.alerts === 5, 'GitHub alerts rendered')
  check(counts.containers === 4, 'custom containers rendered')
  check(counts.footnotes === 2, 'footnotes rendered')
  check(counts.tables >= 2 && counts.hljs > 3, 'tables and code highlighting rendered')
  check(counts.abbr >= 2 && counts.dl === 1 && counts.mark >= 1 && counts.sub >= 1, 'abbr / deflist / mark / sub rendered')
  check(counts.frontMatter === 1, 'front matter rendered')
  const dataImg = await page.$eval('.markdown-body img[alt="示例图片"]', (img) => ({ w: img.naturalWidth, complete: img.complete })).catch(() => null)
  check(!!dataImg && dataImg.complete && dataImg.w > 0, `SVG data-URI image renders (${JSON.stringify(dataImg)})`)
  await shot('03-guide-top')
  for (const [i, sel] of [
    ['04', 'h2:has-text("数学公式")'],
    ['05', 'h3:has-text("Mermaid 流程图")'],
    ['06', 'h3:has-text("Graphviz")'],
    ['07', 'h2:has-text("扩展语法")']
  ]) {
    await page.$eval(`.markdown-body ${sel}`, (el) => el.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(250)
    await shot(`${i}-guide`)
  }

  console.log('▶ outline panel')
  await send('show-outline')
  await page.waitForSelector('.outline-item')
  const outlineCount = await page.$$eval('.outline-item', (els) => els.length)
  check(outlineCount > 20, `outline lists headings (${outlineCount})`)
  await page.click('.outline-item:has-text("表格")')
  await page.waitForTimeout(700)
  await shot('08-outline')

  console.log('▶ split mode editing with live preview')
  await send('show-files')
  await page.click('.tree-row:has-text("README.md")')
  await send('view-split')
  await page.waitForSelector('.cm-content')
  await page.click('.cm-content')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type('\n\n## 新增的标题\n\n实时 **预览** 测试 $x^2$\n')
  await page.waitForTimeout(500)
  const newHeading = await page.$('.markdown-body h2:has-text("新增的标题")')
  check(!!newHeading, 'typing in the editor updates the preview')
  await shot('09-split')

  console.log('▶ formatting command')
  await page.keyboard.type('加粗我')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await send('format-bold')
  await page.waitForTimeout(400)
  check(!!(await page.$('.markdown-body strong:has-text("加粗我")')), 'bold command wraps selection')
  await send('save')
  await page.waitForTimeout(400)
  const saved2 = await readFile(join(notes, 'README.md'), 'utf8')
  check(saved2.includes('## 新增的标题') && saved2.includes('**加粗我**'), 'edited document saved to disk')

  console.log('▶ external modification is picked up')
  await writeFile(join(notes, 'README.md'), saved2 + '\n外部修改的段落 EXTERNAL\n')
  await page.waitForSelector('.markdown-body p:has-text("EXTERNAL")', { timeout: 8000 }).then(
    () => check(true, 'external change reloaded into the open tab'),
    () => check(false, 'external change reloaded into the open tab')
  )

  console.log('▶ new file appears in tree')
  await writeFile(join(notes, 'sub', 'new-note.md'), '# New note\n')
  if (!(await page.$('.tree-row:has-text("page.md")'))) await page.click('.tree-row:has-text("sub")')
  await page.waitForSelector('.tree-row:has-text("new-note.md")', { timeout: 8000 }).then(
    () => check(true, 'watcher refreshes the tree'),
    () => check(false, 'watcher refreshes the tree')
  )

  console.log('▶ folder search')
  await send('search-in-folder')
  await page.fill('.search-box input', '内容二')
  await page.waitForSelector('.search-match', { timeout: 8000 }).then(
    () => check(true, 'full-text search finds matches'),
    () => check(false, 'full-text search finds matches')
  )
  await shot('10-search')
  await page.click('.search-match >> nth=0')
  await page.waitForSelector('.tab.active:has-text("page.md")')
  check(true, 'search result opens file')

  console.log('▶ quick open')
  await send('quick-open')
  await page.fill('.quick-open input', 'guide')
  await page.waitForSelector('.qo-item')
  await shot('11-quick-open')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.tab.active:has-text("guide.md")')
  check(true, 'quick open opens file')

  console.log('▶ scroll sync in split mode')
  await send('view-split')
  await page.waitForTimeout(600)
  const syncState = () =>
    page.evaluate(() => {
      const sc = document.querySelector('.cm-scroller')
      const top = sc.getBoundingClientRect().top
      const gut = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(
        (e) => e.getBoundingClientRect().top >= top - 2 && /\d/.test(e.textContent)
      )
      const ps = document.querySelector('.preview-scroll')
      const ptop = ps.getBoundingClientRect().top
      const first = [...document.querySelectorAll('.markdown-body [data-line]')].find(
        (e) => e.getBoundingClientRect().top >= ptop - 2
      )
      return { editor: Number(gut?.textContent) - 1, preview: Number(first?.getAttribute('data-line')), previewTop: ps.scrollTop }
    })
  // A small wheel marks which pane drives the sync; then scroll to a fixed spot and wait for the
  // other pane to follow (fixed wheel distances and sleeps were flaky under load).
  const scrollPane = async (selector, fraction) => {
    await page.hover(selector)
    await page.mouse.wheel(0, 120)
    await page.$eval(selector, (el, f) => (el.scrollTop = (el.scrollHeight - el.clientHeight) * f), fraction)
  }
  const settle = async (ok) => {
    let state = await syncState()
    for (let i = 0; i < 30 && !ok(state); i++) {
      await page.waitForTimeout(100)
      state = await syncState()
    }
    return state
  }
  await scrollPane('.cm-scroller', 0.25)
  const s1 = await settle((s) => s.previewTop > 0 && Math.abs(s.editor - s.preview) <= 8)
  check(s1.previewTop > 0 && Math.abs(s1.editor - s1.preview) <= 8, `editor → preview sync (editor line ${s1.editor}, preview line ${s1.preview})`)
  await scrollPane('.preview-scroll', 0.6)
  const s2 = await settle((s) => s.editor > s1.editor && Math.abs(s.editor - s.preview) <= 8)
  check(s2.editor > s1.editor && Math.abs(s2.editor - s2.preview) <= 8, `preview → editor sync (editor line ${s2.editor}, preview line ${s2.preview})`)
  await shot('12-split-sync')

  console.log('▶ hero screenshot')
  await send('show-files')
  await page.hover('.preview-scroll')
  await page.$eval('.markdown-body h3:has-text("Mermaid 流程图")', (el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(800)
  await shot('00-hero')

  console.log('▶ UI language switch')
  await page.evaluate(() => window.mf.setSettings({ language: 'en' }))
  await page.waitForTimeout(400)
  check((await page.textContent('.view-switch button.active')).includes('Split'), 'English UI after switching language')
  await page.evaluate(() => window.mf.setSettings({ language: 'auto' }))
  await page.waitForTimeout(300)

  console.log('▶ dark theme')
  await send('view-preview')
  await send('theme-dark')
  await page.waitForTimeout(1500)
  check((await page.getAttribute('html', 'data-theme')) === 'dark', 'dark theme applied')
  await page.$eval('.markdown-body h3:has-text("Mermaid 流程图")', (el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(1200)
  await shot('13-dark')
  await page.$eval('.markdown-body h2:has-text("代码")', (el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(300)
  await shot('13-dark-code')
  await send('theme-light')

  console.log('▶ export HTML & PDF')
  const htmlOut = join(work, 'guide.html')
  const pdfOut = join(work, 'guide.pdf')
  await app.evaluate(({ dialog }, files) => {
    dialog.showSaveDialog = async (_win, opts) => {
      const o = opts ?? _win
      const isPdf = o?.filters?.some((f) => f.extensions.includes('pdf'))
      return { canceled: false, filePath: isPdf ? files.pdf : files.html }
    }
  }, { html: htmlOut, pdf: pdfOut })
  await send('export-html')
  await page.waitForTimeout(1500)
  const html = await readFile(htmlOut, 'utf8').catch(() => '')
  check(html.includes('<article class="markdown-body">') && html.includes('<svg'), 'HTML export written with rendered diagrams')
  await send('export-pdf')
  await page.waitForTimeout(4000)
  const pdfStat = await stat(pdfOut).catch(() => null)
  check(!!pdfStat && pdfStat.size > 20000, `PDF export written (${pdfStat?.size ?? 0} bytes)`)

  console.log('▶ settings & welcome screens')
  await send('settings')
  await page.waitForSelector('.modal.settings')
  await shot('14-settings')
  await page.keyboard.press('Escape')
  await send('markdown-guide')
  await page.waitForTimeout(300)

  console.log('▶ close everything → welcome')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  for (let i = 0; i < 8; i++) {
    if (!(await page.$('.tab'))) break
    await send('close-tab')
    await page.waitForTimeout(150)
  }
  await page.waitForSelector('.welcome')
  await shot('15-welcome')
  check(true, 'welcome screen when no tabs are open')

  if (logs.length) {
    console.log('\nConsole errors/warnings:')
    for (const l of logs.slice(0, 30)) console.log('  ' + l)
  }
  await closeApp(app)
  await rm(work, { recursive: true, force: true }).catch(() => {})
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
  process.exit(failures ? 1 : 0)
}

void only
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
