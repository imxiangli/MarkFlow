/**
 * Find / replace: the styled panel, match count, jump as you type, centred results, the strong
 * highlight and zoom on the current match, and the same in the reading-mode find bar.
 *
 *   npm run build && node tests/find-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-find-'))
const notes = join(work, 'notes')
mkdirSync(notes)
// Matches far apart, so jumping has to scroll.
const lines = ['# 查找测试', '']
for (let i = 1; i <= 400; i++) lines.push(i % 100 === 0 ? `第 ${i} 行：合同状态 Contract 目标` : `第 ${i} 行普通内容 filler`)
const DOC = lines.join('\n') + '\n'
writeFileSync(join(notes, 'doc.md'), DOC)

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
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const count = (scope) => page.textContent(`${scope} .find-count`)
const editor = () =>
  page.evaluate(() => {
    const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    const s = v.state.selection.main
    return { selected: v.state.sliceDoc(s.from, s.to), line: v.state.doc.lineAt(s.head).number, doc: v.state.doc.toString() }
  })
/** The match is on screen, near the vertical middle of the editor. */
const centred = () =>
  page.evaluate(() => {
    const el = document.querySelector('.pane-editor .cm-searchMatch-selected')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const box = document.querySelector('.pane-editor .cm-scroller').getBoundingClientRect()
    return Math.abs(r.top + r.height / 2 - (box.top + box.height / 2)) / box.height
  })
const pulsed = (timeout = 2000) =>
  page.waitForSelector('.mf-find-pulse', { state: 'attached', timeout }).then(() => true, () => false)
const pulseGone = () => page.waitForSelector('.mf-find-pulse', { state: 'detached', timeout: 2000 }).catch(() => {})

try {
  await page.waitForSelector('.tree-row')
  await page.click('.tree-row:has-text("doc.md")')
  await send('view-edit')
  await page.waitForSelector('.pane-editor .cm-content')
  await sleep(200)

  console.log('▶ the panel uses the app theme')
  await send('find')
  await page.waitForSelector('.cm-find-panel input[name=search]')
  check(await page.evaluate(() => document.activeElement?.getAttribute('name') === 'search'), 'find field focused')
  const panelBox = await page.$eval('.cm-find-panel', (el) => {
    const r = el.getBoundingClientRect()
    const e = document.querySelector('.pane-editor .cm-editor').getBoundingClientRect()
    return { floating: e.right - r.right < 40 && r.left - e.left > 40, top: r.top - e.top }
  })
  check(panelBox.floating && panelBox.top < 30, 'floats in the top-right corner of the editor')
  check(!(await page.isVisible('.cm-find-panel input[name=replace]')), 'replace row collapsed until asked for')

  console.log('▶ typing jumps to the first match')
  await page.keyboard.type('合同')
  await page.waitForFunction(() => document.querySelector('.cm-find-panel .find-count')?.textContent === '1/4', null, { timeout: 3000 })
  check(true, 'count shows 1/4')
  let st = await editor()
  check(st.selected === '合同' && st.line === 102, `selected the first match (line ${st.line})`)
  check(await page.evaluate(() => document.activeElement?.getAttribute('name') === 'search'), 'caret stays in the find field')
  await sleep(100)
  const off = await centred()
  check(off !== null && off < 0.12, `match centred in the view (${off?.toFixed(3)} of the height off)`)
  const look = await page.$eval('.pane-editor .cm-searchMatch-selected', (el) => {
    const c = getComputedStyle(el)
    return { bg: c.backgroundColor, color: c.color }
  })
  check(look.bg === 'rgb(255, 150, 50)' && look.color === 'rgb(26, 26, 26)', `current match is solid orange with dark text (${look.bg})`)
  check(await pulsed(), 'zoom effect after typing pauses')
  const pulse = await page.$eval('.mf-find-pulse', (el) => ({ text: el.textContent, zoom: el.style.getPropertyValue('--pulse-zoom') }))
  check(pulse.text === '合同' && Number(pulse.zoom) > 1.3, `zoom shows the matched text (×${pulse.zoom})`)
  await sleep(150)
  await shot('80-find-panel-zoom')
  await pulseGone()
  await shot('81-find-panel')

  console.log('▶ next / previous')
  await page.keyboard.press('Enter')
  await sleep(120)
  st = await editor()
  check(st.line === 202 && (await count('.cm-find-panel')) === '2/4', `Enter → line ${st.line}, 2/4`)
  check(await pulsed(), 'zoom on Enter')
  await pulseGone()
  await page.keyboard.press('Shift+Enter')
  await sleep(120)
  check((await editor()).line === 102 && (await count('.cm-find-panel')) === '1/4', 'Shift+Enter goes back')
  await page.click('.cm-find-panel button[name=next]')
  await sleep(120)
  check((await count('.cm-find-panel')) === '2/4', 'next button')
  check(await page.evaluate(() => document.activeElement?.getAttribute('name') === 'search'), 'buttons keep the caret in the field')

  console.log('▶ options, no results, invalid regex')
  await page.fill('.cm-find-panel input[name=search]', 'contract')
  await page.waitForFunction(() => document.querySelector('.cm-find-panel .find-count')?.textContent.endsWith('4'), null, { timeout: 3000 })
  await page.click('.cm-find-panel button[name=case]')
  await sleep(100)
  check(await page.$eval('.cm-find-panel .find-input-wrap', (e) => e.classList.contains('no-results')), 'match case: no results is marked')
  await page.click('.cm-find-panel button[name=case]')
  await page.click('.cm-find-panel button[name=re]')
  await page.fill('.cm-find-panel input[name=search]', '(')
  await sleep(100)
  check(await page.$eval('.cm-find-panel .find-input-wrap', (e) => e.classList.contains('invalid')), 'invalid regex is marked')
  await page.fill('.cm-find-panel input[name=search]', '第 \\d+00 行')
  await page.waitForFunction(() => document.querySelector('.cm-find-panel .find-count')?.textContent.endsWith('4'), null, { timeout: 3000 })
  check(true, 'regex counts its matches')
  await page.click('.cm-find-panel button[name=re]')

  console.log('▶ replace')
  await send('replace')
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'replace')
  check(await page.isVisible('.cm-find-panel input[name=replace]'), 'Replace opens the second row')
  await shot('82-find-replace')
  await page.fill('.cm-find-panel input[name=search]', '目标')
  await page.waitForFunction(() => document.querySelector('.cm-find-panel .find-count')?.textContent?.includes('4'), null, { timeout: 3000 })
  await page.fill('.cm-find-panel input[name=replace]', '结果')
  await page.keyboard.press('Enter')
  await sleep(150)
  check((await editor()).doc.split('结果').length === 2, 'Enter in the replace field replaces one')
  await page.click('.cm-find-panel button[name=replaceAll]')
  await sleep(150)
  const replaced = (await editor()).doc
  check(replaced.split('结果').length === 5 && !replaced.includes('目标'), 'replace all')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.cm-find-panel', { state: 'detached' })
  check(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), 'Esc closes and returns to the text')

  console.log('▶ dark theme')
  await page.evaluate(() => window.mf.setSettings({ theme: 'dark' }))
  await sleep(300)
  await send('find')
  await page.waitForSelector('.cm-find-panel input[name=search]')
  await page.fill('.cm-find-panel input[name=search]', '合同')
  await sleep(500)
  const dark = await page.$eval('.cm-find-panel .find-input-wrap', (el) => getComputedStyle(el).backgroundColor)
  check(dark !== 'rgb(255, 255, 255)', `find field follows the dark theme (${dark})`)
  await shot('83-find-dark')
  await page.keyboard.press('Escape')

  console.log('▶ reading mode')
  await send('view-preview')
  await page.waitForSelector('.markdown-body h1')
  await send('find')
  await page.waitForSelector('.findbar .find-input')
  await page.waitForFunction(() => document.activeElement?.classList.contains('find-input'))
  await page.keyboard.type('合同')
  await page.waitForFunction(() => document.querySelector('.findbar .find-count')?.textContent === '1/4', null, { timeout: 3000 })
  check(await pulsed(), 'zoom in the reading view')
  const visible = await page.evaluate(() => {
    const el = document.querySelector('.mf-find-pulse')
    const box = document.querySelector('.preview-scroll').getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.top > box.top && r.bottom < box.bottom
  })
  check(visible, 'match scrolled into view')
  await sleep(150)
  await shot('84-find-reading')
  await pulseGone()
  await page.keyboard.press('Enter')
  await sleep(120)
  check((await count('.findbar')) === '2/4', 'Enter steps to the next match')
  check(await pulsed(), 'zoom on each step')
  await page.keyboard.press('Escape')
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll find checks passed')
process.exit(failures ? 1 : 0)
