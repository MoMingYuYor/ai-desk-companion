// 生成托盘图标与应用图标(纯 Node,无外部依赖)
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- PNG 编码 ----------

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 绘制:圆角方块 + 可爱表情 ----------

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.42
  const set = (x, y, [R, G, B, A]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    rgba[i] = R
    rgba[i + 1] = G
    rgba[i + 2] = B
    rgba[i + 3] = A
  }
  const mix = (a, b, t) => Math.round(a + (b - a) * t)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r) {
        // 渐变主体(左上亮)
        const t = Math.min(1, Math.hypot(x - cx * 0.7, y - cy * 0.6) / (r * 1.5))
        set(x, y, [mix(158, 79, t * 255), mix(185, 124, t * 255), mix(255, 255, t * 255), 255])
      }
    }
  }
  // 耳朵
  const er = size * 0.1
  for (const ex of [cx - r * 0.62, cx + r * 0.62]) {
    const ey = cy - r * 0.82
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (Math.hypot(x - ex, y - ey) <= er) set(x, y, [79, 124, 255, 255])
      }
  }
  // 眼睛(白点 + 深色)
  const eyeR = size * 0.045
  const eyeOff = size * 0.16
  for (const ex of [cx - eyeOff, cx + eyeOff]) {
    const ey = cy - size * 0.05
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (Math.hypot(x - ex, y - ey) <= eyeR) set(x, y, [30, 42, 74, 255])
      }
  }
  // 微笑
  const my = cy + size * 0.14
  const mr = size * 0.13
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - my)
      if (d <= mr && y > my) set(x, y, [30, 42, 74, 255])
    }
  return rgba
}

const outDir = join(root, 'resources')
mkdirSync(outDir, { recursive: true })

const png32 = encodePng(32, 32, drawIcon(32))
const png256 = encodePng(256, 256, drawIcon(256))
writeFileSync(join(outDir, 'tray.png'), png32)
writeFileSync(join(outDir, 'icon.png'), png256)

// ICO(内嵌 PNG,Vista+ 支持)
const iconDir = Buffer.alloc(6)
iconDir.writeUInt16LE(0, 0)
iconDir.writeUInt16LE(1, 2) // type icon
iconDir.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = 32
entry[1] = 32
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png32.length, 8)
entry.writeUInt32LE(22, 12) // offset
writeFileSync(join(outDir, 'tray.ico'), Buffer.concat([iconDir, entry, png32]))

console.log('assets generated:', outDir)
