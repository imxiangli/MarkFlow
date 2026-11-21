/**
 * Minimap: drawn next to the source editor, the slider follows scrolling, dragging the slider
 * and clicking the minimap scroll the editor, the wheel over it scrolls, and it can be hidden.
 *
 *   npm run build && node tests/minimap-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/output')
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'markflow-minimap-'))
const notes = join(work, 'notes')
mkdirSync(notes, { recursive: true })

const section = (n) => [
  `## 第 ${n} 节 Section ${n}`,
  '',
  `Paragraph ${n} with **bold** text, a [link](https://example.com/${n}) and \`code\`. 中文段落内容。`,
  '',
  '```js',
  `function f${n}(x) {`,
  `  return x * ${n} // comment`,
  '}',
  '```',
  '',
  `- item ${n}.1`,
  `- item ${n}.2`,
  ''
]
const short = ['# Minimap', '', ...Array.from({ length: 16 }, (_, i) => section(i + 1)).flat()].join('\n')
const long = ['# Long', '', ...Array.from({ length: 600 }, (_, i) => section(i + 1)).flat()].join('\n')
writeFileSync(join(notes, 'short.md'), short)
writeFileSync(join(notes, 'long.md'), long)
mkdirSync(join(work, 'profile'), { recursive: true })
writeFileSync(join(work, 'profile/markflow-config.json'), JSON.stringify({ settings: { language: 'en', viewMode: 'edit' } }))

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol) => Math.abs(a - b) <= tol

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, join(notes, 'short.md')],
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

/** Geometry of the minimap, its slider and the editor scroller. */
const state = () =>
  page.evaluate(() => {
    const mm = document.querySelector('.pane-editor .cm-minimap')
    const sd = document.querySelector('.pane-editor .cm-scroller')
    if (!mm || mm.style.display === 'none') return { visible: false, scrollTop: sd.scrollTop, padding: sd.style.paddingRight }
    const r = mm.getBoundingClientRect()
    const s = mm.querySelector('.cm-minimap-slider')
    const canvas = mm.querySelector('canvas')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let inked = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]) inked++
    return {
      visible: true,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      sliderTop: s.offsetTop,
      sliderHeight: s.offsetHeight,
      inked,
      scrollTop: sd.scrollTop,
      maxScroll: sd.scrollHeight - sd.clientHeight,
      clientHeight: sd.clientHeight,
      scrollbarLeft: sd.getBoundingClientRect().left + sd.clientLeft + sd.clientWidth,
      scrollbarWidth: sd.offsetWidth - sd.clientWidth,
      scrollerRight: sd.getBoundingClientRect().right,
      contentRight: Math.max(...[...sd.querySelectorAll('.cm-line')].map((l) => l.getBoundingClientRect().right)),
      padding: sd.style.paddingRight
    }
  })

async function drag(fromX, fromY, toY) {
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(fromX, fromY + ((toY - fromY) * i) / 8)
  await page.mouse.up()
  await sleep(150)
}

try {
  await page.waitForSelector('.pane-editor .cm-minimap canvas', { timeout: 15000 })
  await sleep(500)

  console.log('Short document (minimap shorter than the editor)')
  let s = await state()
  check(s.visible, 'minimap is shown next to the editor')
  check(near(s.rect.width, 100, 1), `minimap is 100px wide (${s.rect.width})`)
  check(s.scrollbarWidth > 0 && near(s.rect.x + s.rect.width, s.scrollbarLeft, 1), `minimap sits left of the scrollbar (${s.rect.x + s.rect.width} / ${s.scrollbarLeft})`)
  check(near(s.scrollbarLeft + s.scrollbarWidth, s.scrollerRight, 1), 'scrollbar is at the far right')
  check(s.contentRight <= s.rect.x + 1, `wrapped text ends where the minimap starts (${s.contentRight} / ${s.rect.x})`)
  check(s.inked > 500, `document is drawn on the minimap (${s.inked} pixels)`)
  check(s.sliderTop === 0 && s.sliderHeight > 20, `slider marks the top of the document (${s.sliderTop}, ${s.sliderHeight}px)`)
  await shot('minimap-short')

  const x = s.rect.x + 50
  await drag(x, s.rect.y + s.sliderTop + 10, s.rect.y + s.sliderTop + 70)
  let after = await state()
  check(after.scrollTop > 200, `dragging the slider scrolls the editor (scrollTop ${after.scrollTop})`)
  check(near(after.sliderTop, 60, 3), `slider follows the pointer (${after.sliderTop})`)

  // Click below the slider: the clicked spot moves to the middle of the editor.
  const before = after.scrollTop
  await page.mouse.click(x, s.rect.y + after.sliderTop + after.sliderHeight + 120)
  await sleep(150)
  after = await state()
  check(after.scrollTop > before + 300, `clicking below the slider jumps down (${before} → ${after.scrollTop})`)
  const sliderMid = after.sliderTop + after.sliderHeight / 2
  check(near(sliderMid, s.sliderHeight + 60 + 120, 12) || after.scrollTop === after.maxScroll, `clicked spot is centred (${sliderMid})`)

  // Wheel over the minimap scrolls the editor.
  const beforeWheel = after.scrollTop
  await page.mouse.move(x, s.rect.y + 20)
  await page.mouse.wheel(0, -400)
  await sleep(250)
  after = await state()
  check(after.scrollTop < beforeWheel, `wheel over the minimap scrolls the editor (${beforeWheel} → ${after.scrollTop})`)

  // Typing redraws.
  const inkBefore = (await state()).inked
  await page.evaluate(() => {
    const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    v.dispatch({ changes: { from: 0, insert: 'x'.repeat(60).concat('\n').repeat(30) } })
  })
  await sleep(200)
  check((await state()).inked !== inkBefore, 'minimap redraws after an edit')

  console.log('Long document (the minimap scrolls too)')
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('mf:open-paths', [p]), join(notes, 'long.md'))
  await page.waitForFunction(() => document.querySelector('.pane-editor .cm-content')?.textContent?.includes('Long'), null, { timeout: 10000 }).catch(() => {})
  await sleep(500)
  s = await state()
  const isLong = await page.evaluate(() => document.querySelector('.pane-editor .cm-content').cmTile.root.view.state.doc.lines > 5000)
  if (!isLong) {
    // Fall back to replacing the document if opening by IPC isn't wired in this build.
    await page.evaluate((t) => {
      const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } })
      v.scrollDOM.scrollTop = 0
    }, long)
    await sleep(500)
    s = await state()
  }
  await page.evaluate(() => (document.querySelector('.pane-editor .cm-scroller').scrollTop = 0))
  await sleep(200)
  s = await state()
  check(s.sliderTop === 0, `slider starts at the top (${s.sliderTop}, scrollTop ${s.scrollTop}, long ${isLong})`)
  await drag(s.rect.x + 50, s.rect.y + s.sliderTop + 10, s.rect.y + s.rect.height - 2)
  after = await state()
  check(near(after.scrollTop, after.maxScroll, 2), `dragging the slider to the bottom reaches the end (${after.scrollTop} / ${after.maxScroll})`)
  check(near(after.sliderTop + after.sliderHeight, s.rect.height, 2), 'slider sits at the bottom of the minimap')
  check(after.inked > 500, 'the end of the document is drawn')
  await shot('minimap-long-end')
  await drag(s.rect.x + 50, s.rect.y + after.sliderTop + 10, s.rect.y + after.sliderTop + 10 - (s.rect.height - after.sliderHeight) / 2)
  after = await state()
  check(near(after.scrollTop / after.maxScroll, 0.5, 0.03), `half way up the track is half way through the document (${(after.scrollTop / after.maxScroll).toFixed(3)})`)

  console.log('Toggle')
  await send('toggle-minimap')
  await sleep(300)
  s = await state()
  check(!s.visible && s.padding === '', 'View › Show/Hide Minimap hides it and gives the room back')
  await send('toggle-minimap')
  await page.waitForSelector('.pane-editor .cm-minimap canvas', { timeout: 3000 })
  await sleep(200)
  check((await state()).visible, 'and shows it again')

  console.log('Unwrapped lines')
  await send('settings')
  await page.click('.settings-nav button:has-text("Editor")')
  await page.click('.setting-row.check:has-text("Wrap lines") input')
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.evaluate(() => {
    const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    const text = 'start ' + 'word '.repeat(300) + 'END'
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length }, scrollIntoView: true })
    v.focus()
    return null
  })
  await sleep(300)
  s = await state()
  const end = await page.evaluate(() => {
    const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
    return { x: v.coordsAtPos(v.state.doc.length).right, scrollLeft: v.scrollDOM.scrollLeft }
  })
  check(end.scrollLeft > 0 && end.x <= s.rect.x, `cursor at the end of a long line stays left of the minimap (${end.x} / ${s.rect.x})`)
  check(near(s.rect.x + s.rect.width, s.scrollbarLeft, 1), 'minimap still left of the scrollbar')
  await shot('minimap-nowrap')

  console.log('Narrow editor')
  await send('view-split')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700))
  await sleep(500)
  s = await state()
  const editorWidth = await page.evaluate(() => document.querySelector('.pane-editor .cm-editor').clientWidth)
  check(editorWidth >= 480 ? s.visible : !s.visible, `hidden only when the editor is too narrow (${editorWidth}px → ${s.visible ? 'shown' : 'hidden'})`)
  await shot('minimap-split')

  check(errors.length === 0, `no renderer errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} catch (e) {
  console.error(e)
  failures++
} finally {
  await closeApp(app)
}
console.log(failures ? `\n${failures} failure(s)` : '\nall minimap checks passed')
process.exit(failures ? 1 : 0)
