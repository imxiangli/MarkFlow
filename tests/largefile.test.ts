// Unit tests for streaming large files (runs in Node):  npm run test:largefile
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EolNormalizer,
  compactSegments,
  abortLargeWrite,
  beginLargeWrite,
  endLargeWrite,
  openLargeRead,
  readLargeChunk,
  sampleEncoding,
  writeLargeChunk
} from '../src/main/largefile.ts'
import type { TextEncoding } from '../src/shared/types.ts'

const iconv = createRequire(import.meta.url)('iconv-lite')

async function readAll(path: string, encoding?: TextEncoding) {
  const start = await openLargeRead(1, path, encoding)
  let lines: string[] = []
  let chunks = 0
  let restarted: TextEncoding | undefined
  for (;;) {
    const c = await readLargeChunk(start.id)
    if (c.restart) {
      restarted = c.restart
      lines = []
      continue
    }
    for (const seg of c.segments) lines.push(...seg.split('\n'))
    chunks++
    if (c.done) return { text: lines.join('\n'), eol: c.eol, encoding: restarted ?? start.encoding, chunks }
  }
}

test('CR / CRLF split across chunks', () => {
  const n = new EolNormalizer()
  const out = n.push('a\r') + n.push('\nb\r') + n.push('c\r\n') + n.push('d\r') + n.end()
  assert.equal(out, 'a\nb\nc\nd\n')
  assert.equal(n.eol, 'crlf')
})

test('lines are grouped into compact Latin-1 runs and wide runs', () => {
  const text = 'ascii 1\nascii 2\n中文行\ncafé\n\nend'
  const parts = compactSegments(text)
  assert.deepEqual(parts, ['ascii 1\nascii 2', '中文行', 'café\n\nend'])
  assert.deepEqual(parts.flatMap((p) => p.split('\n')), text.split('\n'))
  assert.deepEqual(compactSegments(''), [''])
  assert.deepEqual(compactSegments('中\n'), ['中', ''])
})

test('encoding from a sample cut in the middle of a character', () => {
  const bytes = Buffer.from('中文'.repeat(10), 'utf8')
  assert.equal(sampleEncoding(bytes.subarray(0, bytes.length - 1)), 'utf8', 'truncated last character is fine')
  assert.equal(sampleEncoding(iconv.encode('中文内容', 'gb18030')), 'gb18030')
  assert.equal(sampleEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'utf16le')
})

test('a 10 MB UTF-8 / CRLF file streams back exactly (characters cut by chunk edges)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-large-'))
  try {
    // 3-byte characters and CRLF everywhere, so 4 MB chunk edges fall inside them.
    const line = "INSERT INTO `t` VALUES (1, '公司名称', 'ünïcödé');"
    const lines = Array.from({ length: 160000 }, (_, i) => `${line} -- ${i}`)
    writeFileSync(join(dir, 'dump.sql'), lines.join('\r\n') + '\r\n')
    const r = await readAll(join(dir, 'dump.sql'))
    assert.ok(r.chunks >= 3, `read in ${r.chunks} chunks`)
    assert.equal(r.encoding, 'utf8')
    assert.equal(r.eol, 'crlf')
    assert.equal(r.text, lines.join('\n') + '\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file that stops being UTF-8 after the sample is reread in a legacy encoding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-large-'))
  try {
    const ascii = 'plain ascii line\n'.repeat(80000) // > 1 MB sample
    const tail = iconv.encode('最后是 GB18030 编码的中文\n', 'gb18030')
    writeFileSync(join(dir, 'mixed.txt'), Buffer.concat([Buffer.from(ascii), tail]))
    const r = await readAll(join(dir, 'mixed.txt'))
    assert.equal(r.encoding, 'gb18030')
    assert.ok(r.text.endsWith('最后是 GB18030 编码的中文\n'))
    assert.equal(r.text.length, ascii.length + '最后是 GB18030 编码的中文\n'.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chunked writes keep encoding and line endings, replacing the file at the end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-large-'))
  const path = join(dir, 'out.txt')
  try {
    writeFileSync(path, 'old')
    const id = await beginLargeWrite(1, path, 'gb18030', 'crlf')
    await writeLargeChunk(id, '第一行\n第二行')
    assert.equal(readFileSync(path, 'utf8'), 'old', 'original untouched until the end')
    await writeLargeChunk(id, '\n第三行\n')
    await endLargeWrite(id)
    assert.ok(readFileSync(path).equals(iconv.encode('第一行\r\n第二行\r\n第三行\r\n', 'gb18030')))
    assert.deepEqual(readdirSync(dir), ['out.txt'], 'no temporary file left behind')

    const bomId = await beginLargeWrite(1, path, 'utf8bom', 'lf')
    await writeLargeChunk(bomId, 'x')
    await endLargeWrite(bomId)
    assert.deepEqual([...readFileSync(path)], [0xef, 0xbb, 0xbf, 0x78])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('characters the encoding cannot hold abort the write and keep the original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-large-'))
  const path = join(dir, 'latin.txt')
  try {
    writeFileSync(path, 'original')
    const id = await beginLargeWrite(1, path, 'windows-1252', 'lf')
    await writeLargeChunk(id, 'café\n')
    await assert.rejects(writeLargeChunk(id, '中文'), /EENCODE:windows-1252/)
    await abortLargeWrite(id)
    assert.equal(readFileSync(path, 'utf8'), 'original')
    assert.deepEqual(readdirSync(dir), ['latin.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
