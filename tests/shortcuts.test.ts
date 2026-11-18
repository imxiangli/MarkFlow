// Unit tests for the Sublime-style shortcuts (pure, runs in Node):  npm run test:keys
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import {
  COMMANDS,
  chordPrefix,
  commandForKey,
  displayKey,
  isChord,
  keyOf,
  keysOf,
  normalizeKey,
  normalizeStroke,
  rendererOnlyKeys,
  strokeFromEvent,
  toAccelerator,
  toCodeMirrorKey
} from '../src/shared/keybindings.ts'
import { messages } from '../src/shared/i18n.ts'
import { extractHeadings, plainHeadingText } from '../src/shared/headings.ts'
import {
  bookmarkField,
  bookmarkLines,
  clearBookmarks,
  duplicateSelection,
  expandToBrackets,
  expandToIndentation,
  gotoBookmark,
  insertLineBefore,
  joinLines,
  lowerCase,
  pasteAndIndent,
  selectAllOccurrences,
  skipOccurrence,
  sortLines,
  splitIntoLines,
  toggleBookmark,
  upperCase
} from '../src/renderer/src/editor/sublime.ts'
import { fuzzyScore, paletteMode, parseFileQuery, rank } from '../src/renderer/src/lib/fuzzy.ts'
import { findPattern } from '../src/renderer/src/lib/find.ts'

const PLATFORMS = ['darwin', 'win32', 'linux'] as const

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

test('every shortcut means one thing per platform', () => {
  // ⌥⌘C is "code block", or "match case" while a find field has focus (resolved by context).
  const allowed = new Set(['darwin Alt+Cmd+C'])
  for (const p of PLATFORMS) {
    const seen = new Map<string, string>()
    for (const def of COMMANDS) {
      for (const k of keysOf(def, p)) {
        const key = normalizeKey(k)
        const other = seen.get(key)
        if (other && !allowed.has(`${p} ${key}`)) assert.fail(`${p}: ${key} is bound to both ${other} and ${def.id}`)
        seen.set(key, def.id)
      }
    }
  }
})

test('command ids are unique and labels exist in every language', () => {
  const ids = COMMANDS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const def of COMMANDS) {
    for (const key of [def.label, def.group]) {
      assert.ok(messages['zh-CN'][key], `zh-CN missing ${key}`)
      assert.ok(messages.en[key], `en missing ${key}`)
    }
  }
})

test('⌘K / Ctrl+K is only a chord prefix', () => {
  for (const p of PLATFORMS) {
    const prefix = normalizeStroke(chordPrefix(p))
    for (const def of COMMANDS) {
      for (const k of keysOf(def, p)) {
        if (isChord(k)) assert.equal(normalizeStroke(k.split(' ')[0]), prefix, `${def.id}: ${k}`)
        else assert.notEqual(normalizeStroke(k), prefix, `${def.id} steals the chord prefix`)
      }
    }
  }
})

test('the confirmed conflict resolutions', () => {
  const mac = (id: Parameters<typeof keyOf>[0]) => keyOf(id, 'darwin')
  assert.equal(mac('format-link'), 'Alt+Cmd+K')
  assert.equal(mac('tab-1'), 'Cmd+1')
  assert.equal(mac('tab-9'), 'Cmd+9')
  assert.equal(mac('format-h1'), 'Ctrl+Cmd+1')
  assert.equal(mac('format-h6'), 'Ctrl+Cmd+6')
  assert.equal(mac('use-selection-find'), 'Cmd+E')
  assert.equal(mac('toggle-view'), 'Alt+Cmd+E')
  assert.equal(mac('split-into-lines'), 'Shift+Cmd+L')
  assert.equal(mac('goto-heading'), 'Cmd+R')
  // unchanged
  assert.equal(mac('format-bold'), 'Cmd+B')
  assert.equal(mac('format-italic'), 'Cmd+I')
  assert.equal(mac('format-quote'), 'Alt+Cmd+Q')
  assert.equal(mac('format-code'), 'Ctrl+`')
  assert.equal(mac('view-preview'), 'Alt+Cmd+1')
  assert.equal(mac('view-edit'), 'Alt+Cmd+2')
  assert.equal(mac('view-split'), 'Alt+Cmd+3')
  // Sublime defaults
  assert.equal(mac('quick-open'), 'Cmd+P')
  assert.equal(mac('command-palette'), 'Shift+Cmd+P')
  assert.equal(mac('goto-line'), 'Ctrl+G')
  assert.equal(mac('select-next-occurrence'), 'Cmd+D')
  assert.equal(mac('skip-occurrence'), 'Cmd+K Cmd+D')
  assert.equal(mac('duplicate-line'), 'Shift+Cmd+D')
  assert.equal(mac('delete-line'), 'Ctrl+Shift+K')
  assert.equal(keyOf('select-all-occurrences', 'win32'), 'Alt+F3')
  assert.equal(keyOf('find-next', 'win32'), 'F3')
  assert.equal(keyOf('tab-1', 'win32'), 'Alt+1')
  assert.equal(keyOf('format-h1', 'linux'), 'Ctrl+1')
})

test('chords resolve to commands', () => {
  assert.equal(commandForKey('Cmd+K Cmd+U', 'darwin'), 'upper-case')
  assert.equal(commandForKey('Cmd+K Cmd+L', 'darwin'), 'lower-case')
  assert.equal(commandForKey('Cmd+K Cmd+B', 'darwin'), 'toggle-sidebar')
  assert.equal(commandForKey('Cmd+K Cmd+0', 'darwin'), 'unfold-all')
  assert.equal(commandForKey('Cmd+K Cmd+J', 'darwin'), 'unfold-all')
  assert.equal(commandForKey('Cmd+K Cmd+2', 'darwin'), 'fold-level-2')
  assert.equal(commandForKey('Ctrl+K Ctrl+K', 'win32'), 'delete-to-eol')
  assert.equal(commandForKey('Ctrl+K Ctrl+Backspace', 'linux'), 'delete-to-bol')
  assert.equal(commandForKey('Cmd+K Cmd+Z', 'darwin'), undefined)
})

test('alternate keys are dispatched by the renderer', () => {
  const mac = rendererOnlyKeys('darwin').map((x) => `${x.key}=${x.command}`)
  assert.ok(mac.includes('Ctrl+Tab=next-tab'))
  assert.ok(mac.includes('Shift+Cmd+[=prev-tab'))
  assert.ok(!mac.some((x) => x.includes(' ')), 'chords are forwarded by the main process instead')
  const win = rendererOnlyKeys('win32').map((x) => `${x.key}=${x.command}`)
  assert.ok(win.includes('Alt+Shift+2=view-edit'))
})

test('key notation conversions', () => {
  assert.equal(toAccelerator('Shift+Cmd+P'), 'Shift+Cmd+P')
  assert.equal(toAccelerator('Cmd+K Cmd+U'), undefined)
  assert.equal(toCodeMirrorKey('Ctrl+Cmd+Up'), 'Ctrl-Meta-ArrowUp')
  assert.equal(toCodeMirrorKey('Ctrl+Shift+K'), 'Ctrl-Shift-k')
  assert.equal(toCodeMirrorKey('Alt+Cmd+/'), 'Alt-Meta-/')
  assert.equal(displayKey('Shift+Cmd+P', 'darwin'), '⇧⌘P')
  assert.equal(displayKey('Cmd+K Cmd+U', 'darwin'), '⌘K ⌘U')
  assert.equal(displayKey('Ctrl+-', 'darwin'), '⌃-')
  assert.equal(displayKey('Ctrl+Shift+P', 'win32'), 'Ctrl+Shift+P')
  const ev = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods
  })
  assert.equal(strokeFromEvent(ev('KeyP', { metaKey: true, shiftKey: true }), 'darwin'), 'Shift+Cmd+P')
  assert.equal(strokeFromEvent(ev('BracketRight', { metaKey: true, shiftKey: true }), 'darwin'), 'Shift+Cmd+]')
  assert.equal(strokeFromEvent(ev('Minus', { ctrlKey: true }), 'darwin'), 'Ctrl+-')
  assert.equal(strokeFromEvent(ev('ShiftLeft', { shiftKey: true }), 'darwin'), null)
  // Key codes are layout independent: the stroke for ⌘K is the same on any keyboard.
  assert.equal(normalizeStroke(strokeFromEvent(ev('KeyK', { metaKey: true }), 'darwin')!), normalizeStroke(chordPrefix('darwin')))
  assert.equal(normalizeStroke(strokeFromEvent(ev('KeyK', { ctrlKey: true }), 'linux')!), normalizeStroke(chordPrefix('linux')))
})

/* ------------------------------------------------------------------ */
/* Editor commands                                                     */
/* ------------------------------------------------------------------ */

type Sel = EditorSelection | { anchor: number; head?: number }

function stateOf(doc: string, selection?: Sel) {
  return EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), bookmarkField]
  })
}

function run(cmd: StateCommand, doc: string, selection?: Sel) {
  let state = stateOf(doc, selection)
  const handled = cmd({ state, dispatch: (tr) => (state = tr.state) })
  return { state, handled, doc: state.doc.toString(), ranges: state.selection.ranges.map((r) => [r.from, r.to]) }
}

test('duplicate line / selection (⇧⌘D)', () => {
  assert.equal(run(duplicateSelection, 'a\nb', { anchor: 0 }).doc, 'a\na\nb')
  const r = run(duplicateSelection, 'xab', { anchor: 1, head: 3 })
  assert.equal(r.doc, 'xabab')
  assert.deepEqual(r.ranges, [[3, 5]])
})

test('join lines (⌘J)', () => {
  assert.equal(run(joinLines, 'foo  \n   bar\nbaz', { anchor: 0 }).doc, 'foo bar\nbaz')
  assert.equal(run(joinLines, 'a\nb\nc', { anchor: 0, head: 5 }).doc, 'a b c')
  assert.equal(run(joinLines, 'a\n\nb', { anchor: 0 }).doc, 'a\nb')
})

test('insert line before (⇧⌘↩) keeps indentation', () => {
  const r = run(insertLineBefore, '  x', { anchor: 3 })
  assert.equal(r.doc, '  \n  x')
  assert.deepEqual(r.ranges, [[2, 2]])
})

test('sort lines (F5 case-insensitive, ⌃F5 case-sensitive)', () => {
  assert.equal(run(sortLines(false), 'b\nC\na\nA').doc, 'A\na\nb\nC')
  assert.equal(run(sortLines(true), 'b\nC\na\nA').doc, 'A\nC\na\nb')
  // Only the selected lines.
  assert.equal(run(sortLines(false), 'z\nc\nb\na', { anchor: 2, head: 5 }).doc, 'z\nb\nc\na')
})

test('upper / lower case (⌘K ⌘U, ⌘K ⌘L)', () => {
  assert.equal(run(upperCase, 'hello world', { anchor: 1 }).doc, 'HELLO world')
  assert.equal(run(lowerCase, 'HELLO WORLD', { anchor: 6, head: 11 }).doc, 'HELLO world')
})

test('paste and indent (⇧⌘V)', () => {
  let state = stateOf('    - ', { anchor: 6 })
  pasteAndIndent({ state, dispatch: (tr) => (state = tr.state) }, '  one\n    two\n  three')
  assert.equal(state.doc.toString(), '    - one\n      two\n    three')
})

test('split selection into lines (⇧⌘L)', () => {
  const r = run(splitIntoLines, 'ab\ncd\nef', { anchor: 0, head: 8 })
  assert.deepEqual(r.ranges, [
    [0, 2],
    [3, 5],
    [6, 8]
  ])
  // A selection ending at the start of a line doesn't add that line.
  assert.equal(run(splitIntoLines, 'ab\ncd\nef', { anchor: 0, head: 6 }).ranges.length, 2)
})

test('skip occurrence (⌘K ⌘D) and select all occurrences (⌃⌘G)', () => {
  const skip = run(skipOccurrence, 'foo bar foo baz foo', { anchor: 0, head: 3 })
  assert.deepEqual(skip.ranges, [[8, 11]])
  const all = run(selectAllOccurrences, 'foo bar foo baz foo', { anchor: 1 })
  assert.deepEqual(all.ranges, [
    [0, 3],
    [8, 11],
    [16, 19]
  ])
})

test('expand selection to brackets (⌃⇧M) and indentation (⇧⌘J)', () => {
  const inner = run(expandToBrackets, 'f(a, [b])', { anchor: 6 })
  assert.deepEqual(inner.ranges, [[6, 7]])
  const outer = run(expandToBrackets, 'f(a, [b])', { anchor: 6, head: 7 })
  assert.deepEqual(outer.ranges, [[5, 8]])
  const doc = '- a\n  - b\n  - c\n- d'
  const ind = run(expandToIndentation, doc, { anchor: 6 })
  assert.equal(ind.state.sliceDoc(ind.ranges[0][0], ind.ranges[0][1]), '  - b\n  - c')
})

test('bookmarks (⌘F2, F2, ⇧F2, ⇧⌘F2)', () => {
  let state = stateOf('l0\nl1\nl2\nl3\nl4', { anchor: 3 })
  const target = () => ({ state, dispatch: (tr: Transaction) => (state = tr.state) })
  toggleBookmark(target())
  state = state.update({ selection: { anchor: 9 } }).state
  toggleBookmark(target())
  assert.deepEqual(bookmarkLines(state), [1, 3])
  state = state.update({ selection: { anchor: 0 } }).state
  assert.equal(gotoBookmark(target(), true), 1)
  assert.equal(gotoBookmark(target(), true), 3)
  assert.equal(gotoBookmark(target(), true), 1, 'wraps around')
  assert.equal(gotoBookmark(target(), false), 3, 'wraps backwards')
  // Bookmarks follow edits.
  state = state.update({ changes: { from: 0, insert: 'new\n' } }).state
  assert.deepEqual(bookmarkLines(state), [2, 4])
  // Toggling an existing bookmark removes it.
  state = state.update({ selection: { anchor: state.doc.line(3).from } }).state
  toggleBookmark(target())
  assert.deepEqual(bookmarkLines(state), [4])
  clearBookmarks(target())
  assert.deepEqual(bookmarkLines(state), [])
  assert.equal(gotoBookmark(target(), true), -1)
})

/* ------------------------------------------------------------------ */
/* Go to heading / palette / find                                      */
/* ------------------------------------------------------------------ */

test('headings for ⌘R / ⇧⌘R', () => {
  const doc = [
    '---',
    'title: # not a heading',
    '---',
    '# Title **bold**',
    '',
    '```md',
    '# inside code',
    '```',
    '',
    'Setext Two',
    '----------',
    '',
    '## [Link](x.md) and `code` ##',
    '#hashtag is not a heading',
    '',
    'Setext One',
    '=========='
  ].join('\n')
  assert.deepEqual(extractHeadings(doc), [
    { line: 3, level: 1, text: 'Title bold' },
    { line: 9, level: 2, text: 'Setext Two' },
    { line: 12, level: 2, text: 'Link and code' },
    { line: 15, level: 1, text: 'Setext One' }
  ])
  assert.equal(extractHeadings(doc, 2).length, 2)
  assert.equal(plainHeadingText('[[Page|Alias]] *em* ~~x~~ {#id}'), 'Alias em x')
  // A list item followed by --- is a thematic break, not a setext heading.
  assert.deepEqual(extractHeadings('- item\n---\n'), [])
})

test('Goto Anything prefixes and file:line / file@heading', () => {
  assert.equal(paletteMode(''), 'files')
  assert.equal(paletteMode('>save'), 'commands')
  assert.equal(paletteMode('@intro'), 'headings')
  assert.equal(paletteMode('#install'), 'project')
  assert.equal(paletteMode(':120'), 'line')
  assert.deepEqual(parseFileQuery('readme:12'), { file: 'readme', line: 12, column: undefined })
  assert.deepEqual(parseFileQuery('readme:12:4'), { file: 'readme', line: 12, column: 4 })
  assert.deepEqual(parseFileQuery('guide@install'), { file: 'guide', heading: 'install' })
  assert.deepEqual(parseFileQuery('notes'), { file: 'notes' })
})

test('fuzzy ranking prefers file-name and word-start matches', () => {
  assert.equal(fuzzyScore('xyz', 'readme.md'), -1)
  assert.ok(fuzzyScore('rd', 'docs/readme.md') > 0)
  assert.ok(fuzzyScore('guide', 'docs/guide.md') > fuzzyScore('guide', 'guidelines/other.md'))
  const files = ['src/other.md', 'docs/readme.md', 'notes/ready.md']
  assert.deepEqual(rank(files, 'readme', (f) => f), ['docs/readme.md'])
  assert.deepEqual(rank(files, '', (f) => f, 2), ['src/other.md', 'docs/readme.md'])
})

test('preview find options (⌥⌘R / ⌥⌘C / ⌥⌘W)', () => {
  const count = (q: string, text: string, o: Partial<Parameters<typeof findPattern>[1]> = {}) => {
    const re = findPattern(q, { caseSensitive: false, wholeWord: false, regexp: false, ...o })
    return re ? [...text.matchAll(re)].length : -1
  }
  assert.equal(count('a.b', 'a.b axb'), 1, 'plain text is escaped')
  assert.equal(count('a.b', 'a.b axb', { regexp: true }), 2)
  assert.equal(count('Mark', 'mark MARK Mark'), 3)
  assert.equal(count('Mark', 'mark MARK Mark', { caseSensitive: true }), 1)
  assert.equal(count('cat', 'cat concat cat_x cat.', { wholeWord: true }), 2)
  assert.equal(count('测试', '测试 单元测试用例', { wholeWord: true }), 1)
  assert.equal(count('(', 'x', { regexp: true }), -1, 'invalid regex is reported')
})

test('generated shortcut docs match the registry', () => {
  // Fails with "out of date: …" when keybindings.ts changed without `npm run docs:shortcuts`.
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/gen-shortcuts.mjs', '--check'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'pipe'
  })
})
