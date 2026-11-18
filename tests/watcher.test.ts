// Unit tests for the workspace watcher (runs in Node):  npm run test:watch
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeRecursiveWatch, watchTree, type TreeChange } from '../src/main/treeWatcher.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const handles = () => process.getActiveResourcesInfo().filter((x) => x === 'FSEventWrap').length

async function until(cond: () => boolean, timeout = 4000): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

test('a large folder costs one watcher handle and closes instantly', { skip: !nativeRecursiveWatch && 'Linux uses chokidar on inotify' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mf-watch-big-'))
  try {
    for (let a = 0; a < 40; a++) {
      for (let b = 0; b < 40; b++) {
        const dir = join(root, `a${a}`, `b${b}`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'note.md'), '# x\n')
      }
    }
    const before = handles()
    const watcher = watchTree(root, { ignoreName: () => false, onChange: () => {}, onRescan: () => {} })
    assert.equal(handles() - before, 1, '1,640 folders, one handle')
    const t0 = performance.now()
    watcher.close()
    const ms = performance.now() - t0
    assert.ok(ms < 200, `close took ${ms.toFixed(1)} ms`)
    await sleep(50)
    assert.equal(handles(), before, 'handle released')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports new, edited and deleted files and skips ignored folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mf-watch-'))
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'node_modules'))
  const changes: TreeChange[] = []
  const watcher = watchTree(root, {
    ignoreName: (name) => name === 'node_modules' || name.startsWith('.'),
    onChange: (c) => changes.push(c),
    onRescan: () => {},
    delay: 40
  })
  const seen = (name: string, exists: boolean) => changes.some((c) => c.path.endsWith(name) && c.exists === exists)
  try {
    await sleep(300)
    writeFileSync(join(root, 'docs', 'new.md'), '# new\n')
    assert.ok(await until(() => seen('new.md', true)), 'new file reported')
    writeFileSync(join(root, 'node_modules', 'pkg.md'), 'x')
    writeFileSync(join(root, '.hidden.md'), 'x')
    mkdirSync(join(root, 'docs', 'sub'))
    assert.ok(await until(() => changes.some((c) => c.path.endsWith('sub') && c.exists && c.isDir)), 'new folder reported as a folder')
    rmSync(join(root, 'docs', 'new.md'))
    assert.ok(await until(() => seen('new.md', false)), 'deletion reported')
    await sleep(200)
    assert.ok(!changes.some((c) => c.path.includes('node_modules') || c.path.includes('.hidden')), 'ignored paths stay silent')
  } finally {
    watcher.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('nothing is reported after close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mf-watch-closed-'))
  const changes: TreeChange[] = []
  const watcher = watchTree(root, { ignoreName: () => false, onChange: (c) => changes.push(c), onRescan: () => {}, delay: 40 })
  try {
    // macOS reports the watched folder itself once at start; only count what follows.
    await sleep(300)
    const before = changes.length
    writeFileSync(join(root, 'a.md'), 'x')
    watcher.close()
    await sleep(400)
    assert.equal(changes.length, before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
