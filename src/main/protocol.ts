import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { ASSET_SCHEME } from '@shared/constants'

/** Must run before the app is ready. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

/**
 * Serves local files (images, videos, …) referenced by Markdown documents,
 * e.g. mf-asset://local/Users/me/notes/img.png → /Users/me/notes/img.png
 */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      let p = decodeURIComponent(url.pathname)
      if (process.platform === 'win32') {
        // "/C:/Users/..." → "C:/Users/..."; "//server/share" stays a UNC path.
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
      }
      const headers: Record<string, string> = {}
      const range = request.headers.get('range')
      if (range) headers['range'] = range
      return await net.fetch(pathToFileURL(p).toString(), { headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
