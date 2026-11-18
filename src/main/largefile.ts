/**
 * Large files (like Sublime: open hundreds of MB without a second copy of the text).
 *
 * Instead of one huge string, the file is read and decoded in chunks that the renderer pulls one
 * at a time and turns straight into editor lines; saving streams the lines back into a temporary
 * file that then replaces the original. Encoding and line endings are kept as for small files.
 */
import { chmod, mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import iconv from 'iconv-lite'
import type { LargeChunk, LargeReadStart, LineEnding, TextEncoding } from '@shared/types'
// Explicit extension so Node's test runner can load this file directly.
import { EncodeError, bomEncoding, utf16Pattern } from './textfile.ts'

/** Files above this open in large-file mode. */
export const LARGE_FILE_SIZE = 16 * 1024 * 1024
/** Beyond this the editor would run out of memory: such files get the binary view. */
export const MAX_EDITOR_SIZE = 1024 * 1024 * 1024
const CHUNK_SIZE = 4 * 1024 * 1024
const SAMPLE_SIZE = 1024 * 1024

interface ChunkDecoder {
  write(buf: Buffer): string
  end(): string
}

function chunkDecoder(encoding: TextEncoding, fatal: boolean): ChunkDecoder {
  const web = (label: string, fatal = false) => {
    const d = new TextDecoder(label, { fatal })
    return { write: (b: Buffer) => d.decode(b, { stream: true }), end: () => d.decode() }
  }
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      // Fatal while guessing, so a file that turns out not to be UTF-8 further in is reread properly.
      return web('utf-8', fatal)
    case 'utf16le':
      return web('utf-16le')
    case 'utf16be':
      return web('utf-16be')
    default: {
      const d = iconv.getDecoder(encoding)
      return { write: (b) => d.write(b), end: () => d.end() ?? '' }
    }
  }
}

/** Encoding from the start of a file (a truncated last UTF-8 sequence is fine). */
export function sampleEncoding(sample: Buffer): TextEncoding {
  const bom = bomEncoding(sample)
  if (bom) return bom
  const u16 = utf16Pattern(sample)
  if (u16) return u16
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
    return 'utf8'
  } catch {
    return legacyEncoding(sample)
  }
}

function legacyEncoding(sample: Buffer): TextEncoding {
  for (const enc of ['gb18030', 'big5', 'shift_jis', 'euc-kr'] as const) if (!iconv.decode(sample, enc).includes('�')) return enc
  return 'windows-1252'
}

/** Turns CR / CRLF into LF across chunk boundaries, and notes which ending the file uses. */
export class EolNormalizer {
  private pendingCR = false
  private crlf = 0
  private lf = 0
  private counted = 0

  push(text: string): string {
    let s = this.pendingCR ? '\r' + text : text
    this.pendingCR = s.endsWith('\r')
    if (this.pendingCR) s = s.slice(0, -1)
    // The first few MB decide whether the file uses CRLF.
    if (this.counted < 8 * 1024 * 1024) {
      this.counted += s.length
      const crlf = s.split('\r\n').length - 1
      this.crlf += crlf
      this.lf += s.split('\n').length - 1 - crlf
    }
    return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s
  }

  end(): string {
    const tail = this.pendingCR ? '\n' : ''
    this.pendingCR = false
    return tail
  }

  get eol(): LineEnding {
    return this.crlf > this.lf ? 'crlf' : 'lf'
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

interface ReadSession {
  owner: number
  path: string
  handle: FileHandle
  size: number
  pos: number
  encoding: TextEncoding
  forced: boolean
  decoder: ChunkDecoder
  eol: EolNormalizer
  /** Incomplete last line of the previous chunk (only whole lines are sent). */
  partial: string
}

const reads = new Map<string, ReadSession>()

const WIDE = /[^\x00-\xff]/

/** A copy stored one byte per character (V8 keeps strings two-byte once any part is). */
function oneByte(text: string): string {
  return Buffer.from(text, 'latin1').toString('latin1')
}

/**
 * Whole lines, grouped into runs of Latin-1 lines and runs of wider lines (CJK, emoji…).
 * JavaScript stores a string with even one wide character at two bytes per character, so
 * without this a single Chinese comment would double the memory of every ASCII line near it.
 * Splitting each part on "\n" and concatenating gives back `text.split('\n')` exactly.
 */
export function compactSegments(text: string): string[] {
  if (!WIDE.test(text)) return [oneByte(text)]
  const out: string[] = []
  let group: string[] = []
  let wide = false
  const finish = () => out.push(wide ? group.join('\n') : oneByte(group.join('\n')))
  for (const line of text.split('\n')) {
    const w = WIDE.test(line)
    if (group.length && w !== wide) {
      finish()
      group = []
    }
    group.push(line)
    wide = w
  }
  finish()
  return out
}

export async function openLargeRead(owner: number, path: string, encoding?: TextEncoding): Promise<LargeReadStart> {
  const handle = await open(path, 'r')
  const { size } = await handle.stat()
  const sample = Buffer.alloc(Math.min(size, SAMPLE_SIZE))
  await handle.read(sample, 0, sample.length, 0)
  const enc = encoding ?? sampleEncoding(sample)
  const id = randomUUID()
  reads.set(id, {
    owner,
    path,
    handle,
    size,
    pos: 0,
    encoding: enc,
    forced: !!encoding,
    decoder: chunkDecoder(enc, !encoding),
    eol: new EolNormalizer(),
    partial: ''
  })
  return { id, size, encoding: enc }
}

export async function readLargeChunk(id: string): Promise<LargeChunk> {
  const s = reads.get(id)
  if (!s) throw new Error('Read session closed')
  const buf = Buffer.alloc(Math.min(CHUNK_SIZE, s.size - s.pos))
  const { bytesRead } = buf.length ? await s.handle.read(buf, 0, buf.length, s.pos) : { bytesRead: 0 }
  s.pos += bytesRead
  const done = bytesRead === 0 || s.pos >= s.size
  let text: string
  try {
    text = s.decoder.write(buf.subarray(0, bytesRead)) + (done ? s.decoder.end() : '')
  } catch {
    // Not UTF-8 after all: pick a legacy encoding from this part of the file and start over.
    const enc = legacyEncoding(buf.subarray(0, bytesRead))
    Object.assign(s, { pos: 0, encoding: enc, decoder: chunkDecoder(enc, false), eol: new EolNormalizer(), partial: '' })
    return { segments: [], read: 0, done: false, restart: enc }
  }
  const full = s.partial + s.eol.push(text) + (done ? s.eol.end() : '')
  // Send whole lines only; at the end, everything (the last line may be empty).
  const cut = done ? full.length : full.lastIndexOf('\n')
  if (cut < 0) {
    s.partial = full
    return { segments: [], read: s.pos, done: false }
  }
  s.partial = done ? '' : full.slice(cut + 1)
  const segments = compactSegments(full.slice(0, cut))
  if (done) await closeLargeRead(id)
  return { segments, read: s.pos, done, eol: done ? s.eol.eol : undefined }
}

export async function closeLargeRead(id: string): Promise<void> {
  const s = reads.get(id)
  if (!s) return
  reads.delete(id)
  await s.handle.close().catch(() => {})
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

interface WriteSession {
  owner: number
  path: string
  tmp: string
  handle: FileHandle
  encoding: TextEncoding
  eol: LineEnding
  encoder: { write(s: string): Buffer } | null
}

const writes = new Map<string, WriteSession>()

function bom(encoding: TextEncoding): Buffer {
  if (encoding === 'utf8bom') return Buffer.from([0xef, 0xbb, 0xbf])
  if (encoding === 'utf16le') return Buffer.from([0xff, 0xfe])
  if (encoding === 'utf16be') return Buffer.from([0xfe, 0xff])
  return Buffer.alloc(0)
}

export async function beginLargeWrite(owner: number, path: string, encoding: TextEncoding, eol: LineEnding): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  // Next to the target so the final rename stays on one volume (atomic, no copy).
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.mf-save`)
  const handle = await open(tmp, 'w')
  const id = randomUUID()
  const legacy = !['utf8', 'utf8bom', 'utf16le', 'utf16be'].includes(encoding)
  writes.set(id, { owner, path, tmp, handle, encoding, eol, encoder: legacy ? iconv.getEncoder(encoding) : null })
  const head = bom(encoding)
  if (head.length) await handle.write(head)
  return id
}

export async function writeLargeChunk(id: string, text: string): Promise<void> {
  const s = writes.get(id)
  if (!s) throw new Error('Write session closed')
  const t = s.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
  let buf: Buffer
  if (s.encoder) {
    buf = s.encoder.write(t)
    // Chunks end on line boundaries, so each one round-trips on its own.
    if (iconv.decode(buf, s.encoding) !== t) throw new EncodeError(s.encoding)
  } else if (s.encoding === 'utf16le') {
    buf = Buffer.from(t, 'utf16le')
  } else if (s.encoding === 'utf16be') {
    buf = Buffer.from(t, 'utf16le').swap16()
  } else {
    buf = Buffer.from(t, 'utf8')
  }
  await s.handle.write(buf)
}

export async function endLargeWrite(id: string): Promise<{ mtime: number }> {
  const s = writes.get(id)
  if (!s) throw new Error('Write session closed')
  writes.delete(id)
  await s.handle.sync().catch(() => {})
  await s.handle.close()
  try {
    // Keep the original permissions.
    const st = await stat(s.path)
    await chmod(s.tmp, st.mode)
  } catch {
    // New file.
  }
  await rename(s.tmp, s.path)
  const st = await stat(s.path)
  return { mtime: st.mtimeMs }
}

export async function abortLargeWrite(id: string): Promise<void> {
  const s = writes.get(id)
  if (!s) return
  writes.delete(id)
  await s.handle.close().catch(() => {})
  await unlink(s.tmp).catch(() => {})
}

/** A window went away mid-transfer: release its files. */
export async function disposeLargeSessions(owner: number): Promise<void> {
  for (const [id, s] of reads) if (s.owner === owner) await closeLargeRead(id)
  for (const [id, s] of writes) if (s.owner === owner) await abortLargeWrite(id)
}
