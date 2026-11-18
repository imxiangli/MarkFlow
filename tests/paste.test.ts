// Unit tests for pasting spreadsheet data as Markdown tables (pure, runs in Node):  npm run test:paste
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellCount, decidePaste, displayWidth, gridToMarkdown, parseTsv, trimGrid } from '../src/renderer/src/editor/paste.ts'

test('tab-separated cells as Excel copies them', () => {
  assert.deepEqual(parseTsv('a\tb\r\nc\td\r\n'), [
    ['a', 'b'],
    ['c', 'd']
  ])
  // Quoted cells may contain line breaks, tabs and doubled quotes.
  assert.deepEqual(parseTsv('"line 1\nline 2"\t"say ""hi"""\t"a\tb"\r\n'), [['line 1\nline 2', 'say "hi"', 'a\tb']])
  // A quote in the middle of a cell is literal.
  assert.deepEqual(parseTsv('5" disk\tok'), [['5" disk', 'ok']])
  assert.deepEqual(parseTsv('only'), [['only']])
})

test('ragged edges are trimmed', () => {
  assert.deepEqual(trimGrid([['a', 'b', ''], ['c'], ['', '', '']]), [
    ['a', 'b'],
    ['c', '']
  ])
  assert.equal(cellCount([['a', 'b'], ['c', 'd']]), 4)
})

test('Markdown table: header, escaping, line breaks, numeric columns right-aligned', () => {
  const md = gridToMarkdown([
    ['产品', '销量', '备注'],
    ['苹果', '1,234.00', '新鲜\n当季'],
    ['A|B', '56.5', '']
  ])
  assert.equal(
    md,
    [
      '| 产品 |     销量 | 备注         |',
      '| ---- | -------: | ------------ |',
      '| 苹果 | 1,234.00 | 新鲜<br>当季 |',
      '| A\\|B |     56.5 |              |'
    ].join('\n')
  )
})

test('numbers, percentages and currency count as numeric; mixed columns stay left', () => {
  const md = gridToMarkdown([
    ['a', 'b', 'c'],
    ['12%', '¥1,000', 'x'],
    ['-3.5', '$20', '7']
  ])
  assert.match(md.split('\n')[1], /^\| ---: \| -----: \| --- \|$/)
})

test('a single row is a header-only table', () => {
  assert.equal(gridToMarkdown([['x', 'y']]), '| x   | y   |\n| --- | --- |')
})

test('CJK characters are two columns wide', () => {
  assert.equal(displayWidth('中文ab'), 6)
  assert.equal(displayWidth('ｶﾅ'), 2, 'half-width katakana')
})

const file = (type: string) => ({ type, name: 'image.png' }) as File
const clip = (data: Record<string, string>, files: File[] = []) => ({ getData: (k: string) => data[k] ?? '', files: files as unknown as FileList })

test('clipboard decisions without HTML', () => {
  // Numbers-style: only tab-separated text next to a picture → table.
  const t = decidePaste(clip({ 'text/plain': 'a\tb\nc\td\n' }, [file('image/png')]))
  assert.equal(t.kind, 'table')
  // A picture copied from Finder carries its file name as text: still an image.
  assert.equal(decidePaste(clip({ 'text/plain': 'photo.png' }, [file('image/png')])).kind, 'images')
  // A screenshot.
  assert.equal(decidePaste(clip({}, [file('image/png')])).kind, 'images')
  // Plain text (even tab-separated, e.g. from a terminal) keeps the normal paste.
  assert.equal(decidePaste(clip({ 'text/plain': 'a\tb' })).kind, 'default')
})
