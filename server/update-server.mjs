#!/usr/bin/env node
/**
 * Zero-dependency static server for the MarkFlow update feed.
 *
 *   node server/update-server.mjs --root /srv/markflow --port 8080 [--host 0.0.0.0] [--prefix /markflow/]
 *
 * Serves the folder produced by scripts/release-update.mjs with the headers the updater
 * expects: .gz blobs byte-for-byte (no Content-Encoding), latest.json uncached, content-addressed
 * files cached forever. Put it behind a TLS-terminating proxy (Caddy / nginx) for production,
 * or use server/docker-compose.yml which does all of this with Caddy.
 */
import { createReadStream, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.appimage': 'application/octet-stream',
  '.deb': 'application/vnd.debian.binary-package',
  '.html': 'text/html; charset=utf-8'
}

export function cacheControl(relPath) {
  if (/^latest\.json(\.sig)?$/.test(relPath)) return 'no-cache'
  if (/^(files|full|versions)\//.test(relPath)) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

/** Returns a request handler serving `root` under `prefix` (e.g. "/markflow/"). */
export function createUpdateHandler({ root, prefix = '/', log = () => {} }) {
  const base = resolve(root)
  const pre = prefix.endsWith('/') ? prefix : prefix + '/'
  return async (req, res) => {
    const started = Date.now()
    const done = (status) => log(`${req.method} ${req.url} ${status} ${Date.now() - started}ms`)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return done(405)
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      res.writeHead(400).end()
      return done(400)
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return done(200)
    }
    if (!pathname.startsWith(pre)) {
      res.writeHead(404).end()
      return done(404)
    }
    const rel = pathname.slice(pre.length)
    const file = normalize(join(base, rel))
    if (!rel || rel.includes('\0') || (file !== base && !file.startsWith(base + sep))) {
      res.writeHead(404).end()
      return done(404)
    }
    let st
    try {
      st = await fs.stat(file)
    } catch {
      st = null
    }
    if (!st?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return done(404)
    }
    const headers = {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cacheControl(rel),
      'last-modified': st.mtime.toUTCString(),
      'x-content-type-options': 'nosniff'
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end()
      return done(200)
    }
    res.writeHead(200, headers)
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res)
      .on('finish', () => done(200))
  }
}

export function startUpdateServer({ root, port = 8080, host = '127.0.0.1', prefix = '/', log }) {
  const server = createServer(createUpdateHandler({ root, prefix, log }))
  return new Promise((resolveStart) => server.listen(port, host, () => resolveStart(server)))
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : (process.env[`MARKFLOW_UPDATE_${name.toUpperCase()}`] ?? fallback)
  }
  const root = opt('root', './data')
  const port = Number(opt('port', '8080'))
  const host = opt('host', '0.0.0.0')
  const prefix = opt('prefix', '/markflow/')
  const server = await startUpdateServer({
    root,
    port,
    host,
    prefix,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`)
  })
  const addr = server.address()
  console.log(`MarkFlow update server: http://${addr.address}:${addr.port}${prefix} → ${resolve(root)}`)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
}
