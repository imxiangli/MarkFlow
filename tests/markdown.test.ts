// Unit tests for the Markdown pipeline (pure, runs in Node):  npm run test:md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, slugify, validateLink } from '../src/renderer/src/markdown/md.ts'
import { toggleTaskInSource } from '../src/renderer/src/editor/commands.ts'
import { appendBlock, blockRange, replaceLines } from '../src/renderer/src/lib/blocks.ts'

const html = (src: string) => renderMarkdown(src, 'zh-CN').html

test('CommonMark basics and source line attributes', () => {
  const out = html('# Title\n\nPara *em* **strong**\n\n> quote\n\n1. one\n2. two\n')
  assert.match(out, /<h1 id="title" data-line="0" data-block-start="0">/)
  assert.match(out, /<em>em<\/em> <strong>strong<\/strong>/)
  assert.match(out, /<blockquote data-line="4" data-block-start="4">/)
  assert.match(out, /<ol data-line="6" data-block-start="6">/)
  // nested blocks carry data-line only
  assert.match(out, /<li data-line="6">/)
})

test('GFM: tables, strikethrough, autolinks, task lists', () => {
  const out = html('| a | b |\n|:-|-:|\n| 1 | 2 |\n\n~~del~~ https://example.com\n\n- [ ] todo\n- [x] done\n')
  assert.match(out, /<div class="mf-table-wrap" data-line="0" data-block-start="0"><table data-line="0">/)
  assert.match(out, /<th style="text-align:left">a<\/th>/)
  assert.match(out, /<s>del<\/s>/)
  assert.match(out, /<a href="https:\/\/example.com">/)
  assert.match(out, /<ul class="contains-task-list"/)
  assert.match(out, /data-task-line="6">todo/)
  assert.match(out, /data-task-line="7" checked>done/)
})

test('extensions: footnotes, sub/sup, mark, ins, abbr, deflist, emoji', () => {
  const out = html('A[^1] H~2~O x^2^ ==m== ++i++ :smile: HTML\n\n*[HTML]: Hyper Text\n\nTerm\n: Def\n\n[^1]: Note\n')
  for (const re of [/footnote-ref/, /<sub>2<\/sub>/, /<sup>2<\/sup>/, /<mark>m<\/mark>/, /<ins>i<\/ins>/, /😄/, /<abbr title="Hyper Text">HTML<\/abbr>/, /<dl/, /<dd/]) {
    assert.match(out, re)
  }
})

test('math: inline, block and mhchem', () => {
  const out = html('$E=mc^2$\n\n$$\n\\int x\n$$\n\n```math\n\\ce{H2O}\n```\n')
  assert.equal((out.match(/class="katex"/g) ?? []).length, 3)
  assert.match(out, /class="mf-math-block" data-line="2"/)
  assert.doesNotMatch(out, /mf-error|katex-error/)
})

test('diagram fences become placeholders', () => {
  const out = html('```mermaid\ngraph TD; A-->B\n```\n\n```dot\ndigraph{a->b}\n```\n')
  assert.match(out, /data-kind="mermaid"/)
  assert.match(out, /data-kind="graphviz"/)
  assert.match(out, /A--&gt;B/)
})

test('alerts, containers, TOC, front matter, wikilinks', () => {
  const src = '---\ntitle: T\ntags: [a, b]\n---\n\n# One\n\n[TOC]\n\n## Two\n\n> [!WARNING]\n> careful\n\n::: tip Hi\nbody\n:::\n\n[[Page|Alias]] ![[img.png|120]]\n'
  const r = renderMarkdown(src, 'en')
  assert.match(r.html, /mf-frontmatter/)
  assert.match(r.html, /<span class="mf-fm-tag">a<\/span>/)
  assert.match(r.html, /<nav class="mf-toc" data-line="7" data-block-start="7">.*href="#one".*href="#two"/s)
  assert.deepEqual(r.blocks, [0, 5, 7, 9, 11, 14, 18])
  assert.match(r.html, /<div data-line="11" data-block-start="11" class="markdown-alert markdown-alert-warning">/)
  assert.match(r.html, /markdown-alert-warning/)
  assert.match(r.html, /mf-container-tip.*Hi/s)
  assert.match(r.html, /data-wikilink="Page">Alias</)
  assert.match(r.html, /<img src="img.png" alt="img.png" width="120" class="mf-embed">/)
  assert.deepEqual(
    r.headings.map((h) => [h.level, h.text, h.id, h.line]),
    [
      [1, 'One', 'one', 5],
      [2, 'Two', 'two', 9]
    ]
  )
})

test('attributes only consume real attribute lists', () => {
  const out = html('# Head {#custom .x}\n\nkeep {placeholder}\n\n![i](a.png){width=200}\n')
  assert.match(out, /<h1 id="custom" class="x"/)
  assert.match(out, /keep \{placeholder\}/)
  assert.match(out, /<img src="a.png" alt="i" width="200">/)
})

test('images accept SVG data URIs and file URLs; scripts stay blocked', () => {
  assert.match(html('![a](data:image/svg+xml;base64,PHN2Zz4=)'), /<img src="data:image\/svg\+xml;base64,PHN2Zz4=" alt="a">/)
  assert.match(html('![b](file:///tmp/x.png)'), /<img src="file:\/\/\/tmp\/x.png" alt="b">/)
  assert.equal(validateLink('data:image/png;base64,AAAA'), true)
  assert.equal(validateLink('javascript:alert(1)'), false)
  assert.equal(validateLink('VBScript:x'), false)
  assert.equal(validateLink('data:text/html,<script>'), false)
  assert.doesNotMatch(html('[x](javascript:alert(1))'), /href=/)
})

test('slugify keeps CJK and drops punctuation', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('中文 标题（二）'), '中文-标题二')
})

test('toggleTaskInSource flips the right checkbox', () => {
  const src = '- [ ] a\n  - [x] b\n> - [ ] c\n1. [ ] d'
  assert.equal(toggleTaskInSource(src, 0), '- [x] a\n  - [x] b\n> - [ ] c\n1. [ ] d')
  assert.equal(toggleTaskInSource(src, 1), '- [ ] a\n  - [ ] b\n> - [ ] c\n1. [ ] d')
  assert.equal(toggleTaskInSource(src, 2), '- [ ] a\n  - [x] b\n> - [x] c\n1. [ ] d')
  assert.equal(toggleTaskInSource(src, 3), '- [ ] a\n  - [x] b\n> - [ ] c\n1. [x] d')
  assert.equal(toggleTaskInSource('plain', 0), null)
})

test('block ranges, replacement and append', () => {
  const src = '# A\n\npara one\n[^1]: note\n\n\n- x\n- y\n\n'
  const { blocks } = renderMarkdown(src)
  const lines = src.split('\n')
  assert.deepEqual(blocks, [0, 2, 6])
  // footnote definition stays with the paragraph; trailing blank lines are excluded
  assert.deepEqual(blockRange(blocks, 2, lines), { start: 2, end: 4 })
  assert.deepEqual(blockRange(blocks, 6, lines), { start: 6, end: 8 })
  assert.equal(replaceLines(src, { start: 2, end: 4 }, 'new para\n[^1]: note'), '# A\n\nnew para\n[^1]: note\n\n\n- x\n- y\n\n')
  // emptying a block removes it together with the blank lines after it
  assert.equal(replaceLines(src, { start: 0, end: 1 }, ''), 'para one\n[^1]: note\n\n\n- x\n- y\n\n')
  assert.equal(appendBlock('# A\n\n', '## B'), '# A\n\n## B\n')
  assert.equal(appendBlock('', 'first'), 'first\n')
})
