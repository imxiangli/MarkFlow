// Generates platform icons from build/icon.svg.
//   node scripts/gen-icons.mjs
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = join(root, 'build/icon.svg')
const png = (size, out) => sharp(svg, { density: Math.ceil((72 * size) / 1024) * 2 }).resize(size, size).png().toFile(out)

await png(1024, join(root, 'build/icon.png'))
mkdirSync(join(root, 'resources'), { recursive: true })
await png(512, join(root, 'resources/icon.png'))

// Linux: hicolor sizes
const linuxDir = join(root, 'build/icons')
mkdirSync(linuxDir, { recursive: true })
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) await png(s, join(linuxDir, `${s}x${s}.png`))

// Windows .ico (PNG-compressed entries)
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const bufs = await Promise.all(icoSizes.map((s) => sharp(svg, { density: 300 }).resize(s, s).png().toBuffer()))
const header = Buffer.alloc(6 + 16 * bufs.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(bufs.length, 4)
let offset = header.length
bufs.forEach((b, i) => {
  const s = icoSizes[i]
  const e = 6 + i * 16
  header.writeUInt8(s >= 256 ? 0 : s, e)
  header.writeUInt8(s >= 256 ? 0 : s, e + 1)
  header.writeUInt8(0, e + 2)
  header.writeUInt8(0, e + 3)
  header.writeUInt16LE(1, e + 4)
  header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(b.length, e + 8)
  header.writeUInt32LE(offset, e + 12)
  offset += b.length
})
writeFileSync(join(root, 'build/icon.ico'), Buffer.concat([header, ...bufs]))

// macOS .icns via iconutil (only available on macOS)
if (process.platform === 'darwin') {
  const set = join(root, 'build/icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set)
  for (const s of [16, 32, 128, 256, 512]) {
    await png(s, join(set, `icon_${s}x${s}.png`))
    await png(s * 2, join(set, `icon_${s}x${s}@2x.png`))
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build/icon.icns')])
  rmSync(set, { recursive: true, force: true })
}
console.log('icons generated')
