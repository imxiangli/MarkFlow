/**
 * Large-file mode (see src/main/largefile.ts): the text arrives in chunks and becomes editor
 * lines directly, so there is never one giant string or a second copy of the document; saving
 * streams the lines back in chunks.
 */
import { Text } from '@codemirror/state'
import type { LineEnding, TextEncoding } from '@shared/types'

/** Documents loaded for tabs whose editor state hasn't been created yet. */
export const largeDocs = new Map<string, Text>()

export interface LoadedLarge {
  doc: Text
  encoding: TextEncoding
  eol: LineEnding
}

/**
 * Stream a file into a CodeMirror document. `onProgress` gets 0…1; returning false from
 * `keepGoing` (e.g. the tab was closed) cancels and resolves to null.
 */
export async function loadLargeDoc(
  path: string,
  encoding: TextEncoding | undefined,
  onProgress: (fraction: number) => void,
  keepGoing: () => boolean
): Promise<LoadedLarge | null> {
  const api = window.mf
  const start = await api.largeOpen(path, encoding)
  let enc = start.encoding
  let lines: string[] = []
  let lastReport = 0
  for (;;) {
    if (!keepGoing()) {
      await api.largeClose(start.id)
      return null
    }
    const chunk = await api.largeRead(start.id)
    if (chunk.restart) {
      enc = chunk.restart
      lines = []
      continue
    }
    // Each line stays a slice of its (compact) segment: no further copies.
    for (const segment of chunk.segments) for (const line of segment.split('\n')) lines.push(line)
    const now = performance.now()
    if (now - lastReport > 80) {
      lastReport = now
      onProgress(start.size ? chunk.read / start.size : 1)
    }
    if (chunk.done) {
      onProgress(1)
      return { doc: Text.of(lines), encoding: enc, eol: chunk.eol ?? 'lf' }
    }
  }
}

const WRITE_CHUNK = 4 * 1024 * 1024

/** Write a document to disk in chunks (encoding / line endings applied by the main process). */
export async function saveLargeDoc(doc: Text, path: string, encoding: TextEncoding, eol: LineEnding): Promise<{ mtime: number }> {
  const api = window.mf
  const id = await api.largeWriteBegin(path, { encoding, eol })
  try {
    let batch: string[] = []
    let size = 0
    let first = true
    const flush = async () => {
      // Chunks end on line boundaries; every chunk after the first starts with the line break.
      await api.largeWriteChunk(id, (first ? '' : '\n') + batch.join('\n'))
      first = false
      batch = []
      size = 0
    }
    for (const line of doc.iterLines()) {
      batch.push(line)
      size += line.length + 1
      if (size >= WRITE_CHUNK) await flush()
    }
    if (batch.length || first) await flush()
    return await api.largeWriteEnd(id)
  } catch (e) {
    await api.largeWriteAbort(id)
    throw e
  }
}
