// Unit tests for table row / column editing (pure, runs in Node):  npm run test:table
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignOf, columnAt, editTable, isDelimiterRow, parseTable, splitRow } from '../src/renderer/src/editor/table.ts'

const TABLE = ['| a | b |', '|---|:-:|', '| 1 | 2 |']
const lines = (edit: { text: string } | null) => edit?.text.split('\n')

test('rows split on unescaped pipes, with or without outer pipes', () => {
  assert.deepEqual(splitRow('| x |'), ['x'])
  assert.deepEqual(splitRow('x|y'), ['x', 'y'])
  assert.deepEqual(splitRow('| a \\| b | c |'), ['a \\| b', 'c'])
  assert.deepEqual(splitRow('|a||'), ['a', ''])
})

test('delimiter rows need a pipe (a bare --- is a setext heading)', () => {
  assert.equal(isDelimiterRow('|---|:-:|'), true)
  assert.equal(isDelimiterRow('--- | ---'), true)
  assert.equal(isDelimiterRow('> | - |'), true)
  assert.equal(isDelimiterRow('---'), false)
  assert.equal(isDelimiterRow('| a |'), false)
  assert.equal(parseTable(['a', '---']), null)
})

test('format aligns the columns and keeps alignment markers', () => {
  const edit = editTable(TABLE, 2, 0, 'format')
  assert.deepEqual(lines(edit), ['| a   |  b  |', '| --- | :-: |', '| 1   |  2  |'])
  assert.equal(edit?.line, 2)
  assert.equal(edit?.ch, 2)
})

test('CJK cells count double, blockquote prefixes are kept', () => {
  assert.deepEqual(lines(editTable(['| 名称 |', '|-|', '| x |'], 0, 0, 'format')), ['| 名称 |', '| ---- |', '| x    |'])
  assert.deepEqual(lines(editTable(['> | a |', '> | - |', '> | 1 |'], 0, 0, 'format')), ['> | a   |', '> | --- |', '> | 1   |'])
})

test('ragged rows widen the table instead of losing cells', () => {
  assert.deepEqual(lines(editTable(['| a | b |', '|---|---|', '| 1 | 2 | 3 |'], 0, 0, 'format')), [
    '| a   | b   |     |',
    '| --- | --- | --- |',
    '| 1   | 2   | 3   |'
  ])
})

test('insert rows above / below, never above the header', () => {
  const below = editTable(TABLE, 2, 1, 'rowBelow')
  assert.deepEqual(lines(below), ['| a   |  b  |', '| --- | :-: |', '| 1   |  2  |', '|     |     |'])
  assert.equal(below?.line, 3)
  assert.equal(below?.ch, 8)
  // Below the header (or the delimiter row) is the first body row.
  assert.deepEqual(lines(editTable(TABLE, 1, 0, 'rowBelow'))?.[2], '|     |     |')
  assert.equal(editTable(TABLE, 0, 0, 'rowAbove'), null)
  const above = editTable(TABLE, 2, 0, 'rowAbove')
  assert.deepEqual(lines(above)?.slice(2), ['|     |     |', '| 1   |  2  |'])
  assert.equal(above?.line, 2)
})

test('move and delete rows', () => {
  const two = [...TABLE, '| 3 | 4 |']
  assert.equal(editTable(two, 2, 0, 'rowUp'), null)
  const down = editTable(two, 2, 0, 'rowDown')
  assert.deepEqual(lines(down)?.slice(2), ['| 3   |  4  |', '| 1   |  2  |'])
  assert.equal(down?.line, 3)
  assert.equal(editTable(two, 3, 0, 'rowDown'), null)
  assert.deepEqual(lines(editTable(two, 3, 0, 'rowUp'))?.slice(2), ['| 3   |  4  |', '| 1   |  2  |'])
  assert.equal(editTable(TABLE, 0, 0, 'deleteRow'), null)
  const del = editTable(TABLE, 2, 0, 'deleteRow')
  assert.deepEqual(lines(del), ['| a   |  b  |', '| --- | :-: |'])
  assert.equal(del?.line, 0)
})

test('insert, move and delete columns', () => {
  const left = editTable(TABLE, 0, 0, 'colLeft')
  assert.deepEqual(lines(left), ['|     | a   |  b  |', '| --- | --- | :-: |', '|     | 1   |  2  |'])
  assert.equal(left?.ch, 2)
  const right = editTable(TABLE, 2, 0, 'colRight')
  assert.deepEqual(lines(right)?.[0], '| a   |     |  b  |')
  assert.equal(right?.ch, 8)
  assert.deepEqual(lines(editTable(TABLE, 2, 0, 'colMoveRight')), ['|  b  | a   |', '| :-: | --- |', '|  2  | 1   |'])
  assert.equal(editTable(TABLE, 2, 0, 'colMoveLeft'), null)
  assert.equal(editTable(TABLE, 2, 1, 'colMoveRight'), null)
  assert.deepEqual(lines(editTable(TABLE, 2, 1, 'deleteCol')), ['| a   |', '| --- |', '| 1   |'])
  assert.equal(editTable(['| a |', '|---|'], 0, 0, 'deleteCol'), null)
})

test('column alignment', () => {
  assert.equal(alignOf(TABLE, 1), 'center')
  assert.equal(alignOf(TABLE, 0), null)
  assert.deepEqual(lines(editTable(TABLE, 2, 0, 'alignRight'))?.slice(0, 2), ['|   a |  b  |', '| --: | :-: |'])
  assert.deepEqual(lines(editTable(TABLE, 2, 1, 'alignNone'))?.[1], '| --- | --- |')
  assert.deepEqual(lines(editTable(TABLE, 2, 0, 'alignLeft'))?.[1], '| :-- | :-: |')
})

test('the column under the caret', () => {
  assert.equal(columnAt('| ab | cd |', 3, 2), 0)
  assert.equal(columnAt('| ab | cd |', 7, 2), 1)
  assert.equal(columnAt('ab | cd', 6, 2), 1)
  assert.equal(columnAt('| ab | cd |', 0, 2), 0)
  assert.equal(columnAt('| ab | cd |', 11, 2), 1)
  assert.equal(columnAt('| a \\| b | c |', 8, 2), 0)
})
