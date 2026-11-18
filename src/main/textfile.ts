/**
 * Reading and writing text files in any common encoding, keeping their line endings.
 * Pure functions over Buffers so they can be unit tested without Electron.
 */
import iconv from 'iconv-lite'
import type { LineEnding, TextEncoding } from '@shared/types'

/** How much of a file is inspected to decide whether it is text. */
export const SNIFF_BYTES = 8192

/** Tried in order when a file isn't valid UTF-8 (first one that decodes cleanly wins). */
const LEGACY_ENCODINGS: TextEncoding[] = ['gb18030', 'big5', 'shift_jis', 'euc-kr']

export function bomEncoding(buf: Uint8Array): TextEncoding | null {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8bom'
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  return null
}

/** UTF-16 without a BOM: mostly-ASCII text has a NUL in every other byte. */
export function utf16Pattern(buf: Uint8Array): 'utf16le' | 'utf16be' | null {
  const n = Math.min(buf.length, 1024) & ~1
  if (n < 4) return null
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) even++
    if (buf[i + 1] === 0) odd++
  }
  const pairs = n / 2
  if (odd / pairs > 0.4 && even / pairs < 0.05) return 'utf16le'
  if (even / pairs > 0.4 && odd / pairs < 0.05) return 'utf16be'
  return null
}

/** True when the start of a file looks like binary data (NUL bytes or many control characters). */
export function looksBinary(buf: Uint8Array): boolean {
  if (bomEncoding(buf) || utf16Pattern(buf)) return false
  const n = Math.min(buf.length, SNIFF_BYTES)
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    // Tab, LF, VT, FF, CR and ESC are normal in text.
    if (b < 8 || (b > 13 && b < 32 && b !== 27) || b === 127) control++
  }
  return n > 0 && control / n > 0.1
}

function utf8OrNull(buf: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return null
  }
}

function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf.subarray(0, buf.length & ~1))
  out.swap16()
  return out
}

function decodeAs(buf: Buffer, encoding: TextEncoding): string {
  const bom = bomEncoding(buf)
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      return buf.subarray(bom === 'utf8bom' ? 3 : 0).toString('utf8')
    case 'utf16le':
      return buf.subarray(bom === 'utf16le' ? 2 : 0).toString('utf16le')
    case 'utf16be':
      return swap16(buf.subarray(bom === 'utf16be' ? 2 : 0)).toString('utf16le')
    default:
      return iconv.decode(buf, encoding)
  }
}

export function detectEncoding(buf: Buffer): TextEncoding {
  const bom = bomEncoding(buf)
  if (bom) return bom
  const u16 = utf16Pattern(buf)
  if (u16) return u16
  if (utf8OrNull(buf) !== null) return 'utf8'
  for (const enc of LEGACY_ENCODINGS) if (!iconv.decode(buf, enc).includes('�')) return enc
  return 'windows-1252'
}

/** "\n"-only text plus the line ending the file mostly uses. */
export function normalizeEol(text: string): { content: string; eol: LineEnding } {
  if (!text.includes('\r')) return { content: text, eol: 'lf' }
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  return { content: text.replace(/\r\n?/g, '\n'), eol: crlf > lf ? 'crlf' : 'lf' }
}

export interface DecodedText {
  content: string
  encoding: TextEncoding
  eol: LineEnding
}

/** Decode a whole file, detecting the encoding unless one is given. */
export function decodeText(buf: Buffer, encoding?: TextEncoding): DecodedText {
  const enc = encoding ?? detectEncoding(buf)
  // Valid UTF-8 is by far the common case: decode it once.
  const text = enc === 'utf8' && !encoding ? (utf8OrNull(buf) ?? decodeAs(buf, enc)) : decodeAs(buf, enc)
  return { ...normalizeEol(text), encoding: enc }
}

/** Thrown when text contains characters the target encoding can't represent. */
export class EncodeError extends Error {
  encoding: TextEncoding
  constructor(encoding: TextEncoding) {
    super(`EENCODE:${encoding}`)
    this.encoding = encoding
  }
}

export function encodeText(content: string, encoding: TextEncoding = 'utf8', eol: LineEnding = 'lf'): Buffer {
  const text = eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : content
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swap16(Buffer.from(text, 'utf16le'))])
    default: {
      const out = iconv.encode(text, encoding)
      // iconv-lite silently substitutes "?" for unmappable characters; refuse instead of losing text.
      if (iconv.decode(out, encoding) !== text) throw new EncodeError(encoding)
      return out
    }
  }
}
