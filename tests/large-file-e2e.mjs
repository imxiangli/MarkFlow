/**
 * Large files (a ~300 MB SQL dump): streamed into the editor without a second copy, editable,
 * saved in chunks, reloaded on external changes.
 *
 *   npm run build && node tests/large-file-e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { closeApp } from './helpers.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'markflow-largefile-'))
const file = join(work, 'rz.sql')

// ---- a Navicat-style dump: header, DDL with Chinese comments, many rows, a few huge lines
const fd = openSync(file, 'w')
const HEADER = `/*
 Navicat Premium Data Transfer

 Source Server         : RZ
 Source Server Type    : MySQL
 Source Schema         : rz

 Date: 23/10/2026 23:20:27
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for agency_company_entities
-- ----------------------------
DROP TABLE IF EXISTS \`agency_company_entities\`;
CREATE TABLE \`agency_company_entities\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`company_name\` varchar(200) COLLATE utf8mb4_general_ci NOT NULL COMMENT '公司名称',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;
`
writeSync(fd, HEADER)
let lines = HEADER.split('\n').length - 1
const LONG_LINE_AT = []
let buf = []
let size = 0
const flush = () => {
  writeSync(fd, buf.join(''))
  buf = []
  size = 0
}
for (let i = 0; i < 1_500_000; i++) {
  if (i % 300_000 === 150_000) {
    // One INSERT with thousands of rows on a single ~2 MB line.
    const values = Array.from({ length: 16000 }, (_, k) => `(${k}, '代理公司${k}', '2026-10-23 23:20:27')`).join(',')
    buf.push(`INSERT INTO \`agency_company_entities\` VALUES ${values};\n`)
    LONG_LINE_AT.push(lines + 1)
    lines++
  }
  // Like a real dump: some rows carry Chinese text, most are plain ASCII.
  const name = i % 4 === 0 ? `代理公司名称${i}` : `Agency Company ${i}`
  buf.push(`INSERT INTO \`agency_company_entities\` VALUES (${i}, '2026-10-23 23:20:27.000', 0, NULL, 'tenant-${i % 97}', '${name}', 'https://example.com/license/${i}.png');\n`)
  lines++
  size += 160
  if (size > 8_000_000) flush()
}
buf.push('-- END OF DUMP\n')
lines++
flush()
closeSync(fd)
const fileSize = statSync(file).size
const totalLines = lines + 1 // the empty line after the final newline

let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const head = (n) => {
  const b = Buffer.alloc(n)
  const f = openSync(file, 'r')
  readSync(f, b, 0, n, 0)
  closeSync(f)
  return b
}
const originalHead = head(4096)

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, MARKFLOW_USER_DATA: join(work, 'profile') }
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880))
const send = (cmd) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('mf:menu-command', c), cmd)
const view = (fn, arg) =>
  page.evaluate(
    ([src, a]) => {
      const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
      return new Function('view', 'arg', `return (${src})(view, arg)`)(v, a)
    },
    [fn.toString(), arg]
  )
const docInfo = () =>
  page.evaluate(() => {
    const v = document.querySelector('.pane-editor .cm-content')?.cmTile?.root?.view
    if (!v) return null
    const d = v.state.doc
    return { lines: d.lines, length: d.length, first: d.line(1).text, last: d.line(d.lines).text, beforeLast: d.line(d.lines - 1).text }
  })

try {
  console.log(`▶ open a ${mb(fileSize)} SQL dump with ${totalLines.toLocaleString()} lines`)
  await page.waitForSelector('.app')
  const t0 = Date.now()
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('mf:open-paths', [p]), file)
  const sawProgress = await page
    .waitForSelector('.large-progress', { timeout: 5000 })
    .then(() => true, () => false)
  check(sawProgress, 'progress view while the file streams in')
  await page.waitForFunction(() => document.querySelector('.pane-editor .cm-line')?.textContent === '/*', null, { timeout: 120000 })
  const openMs = Date.now() - t0
  check(openMs < 60000, `opened in ${(openMs / 1000).toFixed(1)} s`)
  const info = await docInfo()
  check(info.lines === totalLines && info.beforeLast === '-- END OF DUMP', `all ${info.lines.toLocaleString()} lines loaded, last one intact`)
  const status = await page.textContent('.statusbar')
  check(status.includes('大文件') || status.includes('Large file'), 'status bar shows large file mode')
  check(status.includes(totalLines.toLocaleString()), 'status bar shows the line count')
  // Measure what stays alive, not garbage the collector hasn't reached yet.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await sleep(300)
  const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize
  check(heap < fileSize * 2, `renderer JS heap ${mb(heap)} for a ${mb(fileSize)} file (${(heap / fileSize).toFixed(2)}×)`)
  const wrapped = await page.$eval('.pane-editor .cm-content', (el) => el.classList.contains('cm-lineWrapping'))
  check(!wrapped, 'line wrapping off')
  await page.screenshot({ path: join(root, 'tests/output/70-large-file.png') })

  console.log('▶ moving around stays responsive')
  await page.click('.pane-editor .cm-content')
  let t1 = Date.now()
  await page.keyboard.press(`${mod}+${process.platform === 'darwin' ? 'ArrowDown' : 'End'}`)
  await page.waitForFunction(() => [...document.querySelectorAll('.pane-editor .cm-line')].some((l) => l.textContent === '-- END OF DUMP'), null, { timeout: 10000 })
  check(Date.now() - t1 < 3000, `jump to the end in ${Date.now() - t1} ms`)
  t1 = Date.now()
  await send('goto-line')
  await page.waitForSelector('.palette input')
  await page.keyboard.type(String(LONG_LINE_AT[1]))
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    (n) => {
      const v = document.querySelector('.pane-editor .cm-content').cmTile.root.view
      return v.state.doc.lineAt(v.state.selection.main.head).number === n
    },
    LONG_LINE_AT[1],
    { timeout: 10000 }
  )
  await sleep(300)
  const domChars = await page.$$eval('.pane-editor .cm-line', (ls) => ls.reduce((n, l) => n + l.textContent.length, 0))
  check(Date.now() - t1 < 4000 && domChars < 500_000, `2 MB line shown in ${Date.now() - t1} ms (${domChars.toLocaleString()} characters in the DOM)`)

  console.log('▶ find stays responsive')
  await send('find')
  await page.waitForSelector('.cm-find-panel input[name=search]')
  // Watch for blocked frames while the matches are counted in the background.
  await page.evaluate(() => {
    window.__maxGap = 0
    window.__watching = true
    let last = performance.now()
    const tick = (now) => {
      window.__maxGap = Math.max(window.__maxGap, now - last)
      last = now
      if (window.__watching) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  t1 = Date.now()
  await page.keyboard.type('-- END OF DUMP')
  await page.waitForFunction(() => /^(1 |1\/1)/.test(document.querySelector('.cm-find-panel .find-count')?.textContent ?? ''), null, { timeout: 60000 })
  const countMs = Date.now() - t1
  const maxGap = await page.evaluate(() => {
    window.__watching = false
    return window.__maxGap
  })
  check(maxGap < 500, `counted the whole file in ${(countMs / 1000).toFixed(1)} s, longest UI stall ${Math.round(maxGap)} ms`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.cm-find-panel .find-count')?.textContent === '1/1', null, { timeout: 15000 })
  check(await page.waitForSelector('.pane-editor .cm-searchMatch-selected', { timeout: 5000 }).then(() => true, () => false), 'Enter jumps to the only match, at the end of the file')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.cm-find-panel', { state: 'detached' })

  console.log('▶ edit and save')
  await view((v) => {
    v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true })
    v.focus()
  })
  t1 = Date.now()
  await page.keyboard.type('-- edited in MarkFlow')
  check(Date.now() - t1 < 3000, `typing 21 characters took ${Date.now() - t1} ms`)
  await page.waitForSelector('.tab.active.dirty')
  t1 = Date.now()
  await send('save')
  await page.waitForFunction(() => !document.querySelector('.tab.active.dirty'), null, { timeout: 60000 })
  const saveMs = Date.now() - t1
  check(saveMs < 30000, `saved in ${(saveMs / 1000).toFixed(1)} s`)
  const after = statSync(file).size
  check(after === fileSize + '-- edited in MarkFlow'.length, `file grew by exactly the typed text (${after - fileSize} bytes)`)
  check(head(4096).equals(originalHead), 'start of the file unchanged byte for byte')
  const tail = Buffer.alloc(40)
  const f = openSync(file, 'r')
  readSync(f, tail, 0, 40, after - 40)
  closeSync(f)
  check(tail.toString().endsWith('-- END OF DUMP\n-- edited in MarkFlow'), 'end of the file has the edit')
  check((await page.$$('.toast.error')).length === 0, 'no error toasts')

  console.log('▶ external change reloads the file')
  await sleep(2000)
  appendFileSync(file, '\n-- appended outside')
  const reloaded = await page
    .waitForFunction(
      () => {
        const v = document.querySelector('.pane-editor .cm-content')?.cmTile?.root?.view
        return v && v.state.doc.line(v.state.doc.lines).text === '-- appended outside'
      },
      null,
      { timeout: 120000 }
    )
    .then(() => true, () => false)
  check(reloaded, 'reloaded after the file changed on disk')
} catch (err) {
  console.error(err)
  failures++
} finally {
  await closeApp(app)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll large-file checks passed')
process.exit(failures ? 1 : 0)
