// Unit tests for opening any text file (pure, runs in Node):  npm run test:text
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  EncodeError,
  decodeText,
  detectEncoding,
  encodeText,
  looksBinary,
  normalizeEol,
  utf16Pattern
} from '../src/main/textfile.ts'
import {
  COMMON_TYPES,
  DOCUMENT_TYPES,
  MARKDOWN_TYPE,
  PLAIN_TEXT,
  SYNTAXES,
  detectLanguage,
  documentType,
  languageAfterSave,
  nameForType,
  tabLanguage,
  typeExtension
} from '../src/renderer/src/editor/languages.ts'

const iconv = createRequire(import.meta.url)('iconv-lite')
const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])

test('binary sniffing', () => {
  assert.equal(looksBinary(Buffer.from('plain text\nwith lines\tand tabs\n')), false)
  assert.equal(looksBinary(Buffer.from('中文 UTF-8 文本')), false)
  assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), true, 'NUL byte')
  assert.equal(looksBinary(Buffer.from([1, 2, 3, 4, 5, 6, 0x41, 0x42])), true, 'mostly control characters')
  assert.equal(looksBinary(utf16le('UTF-16 has NULs')), false, 'UTF-16 with BOM is text')
  assert.equal(looksBinary(Buffer.from('UTF-16 without BOM', 'utf16le')), false, 'BOM-less UTF-16 is text')
  assert.equal(looksBinary(Buffer.from('\x1b[31mred\x1b[0m ANSI log\n')), false, 'ESC sequences are text')
  assert.equal(looksBinary(Buffer.alloc(0)), false, 'empty file is text')
})

test('encoding detection', () => {
  assert.equal(detectEncoding(Buffer.from('héllo 中文')), 'utf8')
  assert.equal(detectEncoding(Buffer.from('﻿bom', 'utf8')), 'utf8bom')
  assert.equal(detectEncoding(utf16le('x')), 'utf16le')
  assert.equal(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x41])), 'utf16be')
  assert.equal(utf16Pattern(Buffer.from('plain ascii', 'utf16le')), 'utf16le')
  assert.equal(detectEncoding(iconv.encode('中文内容：简体与繁體', 'gb18030')), 'gb18030')
  assert.equal(detectEncoding(iconv.encode('café crème brûlée', 'windows-1252')), 'windows-1252')
})

test('decoding normalises line endings and remembers them', () => {
  assert.deepEqual(normalizeEol('a\r\nb\r\nc'), { content: 'a\nb\nc', eol: 'crlf' })
  assert.deepEqual(normalizeEol('a\nb\r\nc\nd'), { content: 'a\nb\nc\nd', eol: 'lf' })
  assert.deepEqual(normalizeEol('no breaks'), { content: 'no breaks', eol: 'lf' })
  const d = decodeText(iconv.encode('第一行\r\n第二行\r\n', 'gb18030'))
  assert.deepEqual(d, { content: '第一行\n第二行\n', encoding: 'gb18030', eol: 'crlf' })
  assert.equal(decodeText(Buffer.from('﻿hi', 'utf8')).content, 'hi', 'BOM stripped')
  assert.equal(decodeText(Buffer.from('﻿hi', 'utf8'), 'utf8').content, 'hi', 'BOM stripped when forced')
  assert.equal(decodeText(utf16le('UTF-16 文本')).content, 'UTF-16 文本')
})

test('encoding round trips keep the bytes', () => {
  const text = 'line 1 中文\nline 2 ✓\n'
  for (const enc of ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'gb18030'] as const) {
    for (const eol of ['lf', 'crlf'] as const) {
      const bytes = encodeText(text, enc, eol)
      const back = decodeText(bytes, enc)
      assert.equal(back.content, text, `${enc}/${eol}`)
      assert.equal(back.eol, eol, `${enc}/${eol} line endings`)
    }
  }
  assert.deepEqual([...encodeText('a', 'utf8bom').subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.deepEqual([...encodeText('A', 'utf16be')], [0xfe, 0xff, 0x00, 0x41])
  assert.equal(encodeText('a\nb', 'utf8', 'crlf').toString(), 'a\r\nb')
  // An original GB18030 file is written back byte for byte.
  const original = iconv.encode('原始内容\r\n', 'gb18030')
  const { content, encoding, eol } = decodeText(original)
  assert.ok(encodeText(content, encoding, eol).equals(original))
})

test('characters a legacy encoding cannot hold are refused, not replaced', () => {
  assert.throws(() => encodeText('café 中文', 'windows-1252'), (e: unknown) => e instanceof EncodeError && e.message === 'EENCODE:windows-1252')
  assert.throws(() => encodeText('简体字', 'big5'), EncodeError)
  assert.doesNotThrow(() => encodeText('😀 any Unicode', 'gb18030'), 'GB18030 covers all of Unicode')
})

test('syntax detection for code files', () => {
  const lang = (name: string, content = '') => detectLanguage(name, content)?.name ?? null
  assert.equal(lang('src/app.ts'), 'TypeScript')
  assert.equal(lang('main.py'), 'Python')
  assert.equal(lang('Dockerfile'), 'Dockerfile')
  assert.equal(lang('CMakeLists.txt'), 'CMake')
  assert.equal(lang('.bashrc'), 'Shell')
  assert.equal(lang('Makefile'), 'Shell')
  assert.equal(lang('Gemfile'), 'Ruby')
  assert.equal(lang('.env.local'), 'Properties files')
  assert.equal(lang('tsconfig.jsonc'), 'JSON')
  assert.equal(lang('App.svelte'), 'HTML')
  assert.equal(lang('nginx.conf'), 'Nginx')
  assert.equal(lang('build', '#!/usr/bin/env bash\necho hi'), 'Shell')
  assert.equal(lang('run', '#!/usr/bin/python3\nprint(1)'), 'Python')
  assert.equal(lang('feed', '<?xml version="1.0"?>\n<rss/>'), 'XML')
  assert.equal(lang('notes.txt'), null)
  assert.equal(lang('server.log'), null)
  assert.equal(tabLanguage({ name: 'a.ts', language: 'plain' }, '')?.name ?? null, null, 'user chose plain text')
  assert.equal(tabLanguage({ name: 'a.txt', language: 'Rust' }, '')?.name, 'Rust', 'user choice wins')
})

test('new document types: names follow the type', () => {
  assert.equal(nameForType('未命名-1.md', 'HTML'), '未命名-1.html')
  assert.equal(nameForType('Untitled-1.html', PLAIN_TEXT), 'Untitled-1.txt')
  assert.equal(nameForType('Untitled-1.txt', MARKDOWN_TYPE), 'Untitled-1.md')
  assert.equal(nameForType('Untitled-1.md', 'Dockerfile'), 'Untitled-1', 'no extension of its own')
  assert.equal(nameForType('Untitled-1', 'Rust'), 'Untitled-1.rs', 'and back')
  assert.equal(typeExtension('Python'), 'py', 'not "BUILD", which language-data lists first')
  assert.equal(typeExtension('LaTeX'), 'tex')
  assert.equal(typeExtension('MySQL'), 'sql')
})

test('new document types: every common type is what its file name says', () => {
  assert.equal(DOCUMENT_TYPES.length, SYNTAXES.length + 1, 'all syntaxes and plain text, none twice')
  assert.equal(new Set(DOCUMENT_TYPES).size, DOCUMENT_TYPES.length)
  for (const type of COMMON_TYPES) {
    const name = nameForType('x.md', type)
    assert.equal(detectLanguage(name)?.name ?? PLAIN_TEXT, type, name)
  }
})

test('new document types: current type of a tab', () => {
  assert.equal(documentType({ kind: 'markdown', name: 'a.md' }), MARKDOWN_TYPE)
  assert.equal(documentType({ kind: 'text', name: 'a.txt', language: PLAIN_TEXT }), PLAIN_TEXT)
  assert.equal(documentType({ kind: 'text', name: 'a.html', language: 'HTML' }), 'HTML')
  assert.equal(documentType({ kind: 'text', name: 'Untitled-1', language: 'Dockerfile' }), 'Dockerfile')
})

test('new document types: the file name decides once saved', () => {
  assert.equal(languageAfterSave(undefined, 'a.py'), undefined)
  assert.equal(languageAfterSave('HTML', 'a.html'), undefined, 'same as the name says')
  assert.equal(languageAfterSave('JavaScript', 'a.py'), undefined, 'the name says something else')
  assert.equal(languageAfterSave(PLAIN_TEXT, 'a.js'), undefined, 'plain text saved as code')
  assert.equal(languageAfterSave('JavaScript', 'a.txt'), 'JavaScript', 'the name says nothing')
  assert.equal(languageAfterSave('Python', 'script'), 'Python', 'no extension')
  assert.equal(languageAfterSave('Objective-C', 'a.m'), 'Objective-C', 'extension several syntaxes share')
  assert.equal(languageAfterSave('MySQL', 'a.sql'), 'MySQL', 'dialect of the syntax the name says')
})
