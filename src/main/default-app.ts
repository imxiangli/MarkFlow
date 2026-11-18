import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BUNDLE_ID = 'com.markflow.app'
const DESKTOP_FILE = 'markflow.desktop'

export interface DefaultAppResult {
  ok: boolean
  message?: string
  action?: 'windows-settings'
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/**
 * Ask the OS to make MarkFlow the default handler for Markdown files.
 * The installers already register MarkFlow as an "Open With" candidate;
 * this goes one step further where the platform allows it.
 */
export async function setAsDefaultMarkdownApp(): Promise<DefaultAppResult> {
  if (!app.isPackaged) return { ok: false, message: 'Only available in the packaged app' }
  try {
    if (process.platform === 'darwin') {
      const types = ['net.daringfireball.markdown', 'public.markdown']
      const script = [
        "ObjC.import('CoreServices');",
        `var types = ${JSON.stringify(types)};`,
        'var codes = types.map(function (t) {',
        `  return $.LSSetDefaultRoleHandlerForContentType($(t), 0xFFFFFFFF, $('${BUNDLE_ID}'));`,
        '});',
        'codes.join(",");'
      ].join('\n')
      const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', script])
      const codes = stdout.trim().split(',').map((s) => Number(s))
      // The first UTI is the canonical one; the second may not exist on older systems.
      if (codes[0] === 0) return { ok: true }
      return { ok: false, message: `LaunchServices error ${stdout.trim()}` }
    }
    if (process.platform === 'win32') {
      // Windows 10/11 do not allow apps to silently change defaults.
      await shell.openExternal('ms-settings:defaultapps')
      return { ok: true, action: 'windows-settings' }
    }
    const candidates = [
      join(homedir(), '.local/share/applications', DESKTOP_FILE),
      join('/usr/share/applications', DESKTOP_FILE),
      join('/usr/local/share/applications', DESKTOP_FILE)
    ]
    if (!candidates.some((p) => existsSync(p))) {
      return { ok: false, message: `${DESKTOP_FILE} not found (AppImage builds need AppImageLauncher or a .desktop file)` }
    }
    await run('xdg-mime', ['default', DESKTOP_FILE, 'text/markdown'])
    await run('xdg-mime', ['default', DESKTOP_FILE, 'text/x-markdown']).catch(() => undefined)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
