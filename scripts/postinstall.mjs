// npm may skip dependency install scripts; make sure the Electron binary is present.
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules/electron')
const pathFile = join(electronDir, 'path.txt')
const ok = existsSync(pathFile) && existsSync(join(electronDir, 'dist', readFileSync(pathFile, 'utf8').trim()))
if (existsSync(electronDir) && !ok) {
  console.log('[postinstall] downloading Electron binary…')
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' })
}
