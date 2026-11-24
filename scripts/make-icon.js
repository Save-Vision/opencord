'use strict'
// Renders build/icon.png (512×512): a speech bubble with three connected dots inside, you
// and your friends talking directly to each other. The same drawing as the in-app logo
// (src/renderer/lib/logo.js), on a 64-unit grid. Pure Node, no dependencies.
// Run: node scripts/make-icon.js
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const S = 512
const SS = 4 // supersampling per axis
const U = S / 64 // pixels per logo unit
const A = [52, 211, 192] // gradient start (top left)
const B = [91, 108, 240] // gradient end (bottom right)
const INK = [255, 255, 255]
const NODES = [[32, 21.5], [23.5, 36], [40.5, 36]]

const mix = (t) => A.map((v, i) => v + (B[i] - v) * Math.min(1, Math.max(0, t)))
const grad = (x, y) => mix((x + y) / 128)

function inRoundedSquare (x, y) {
  const rad = 17
  const cx = Math.min(Math.max(x, 2 + rad), 62 - rad)
  const cy = Math.min(Math.max(y, 2 + rad), 62 - rad)
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
}

function inTriangle (p, a, b, c) {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  const d1 = s(p, a, b); const d2 = s(p, b, c); const d3 = s(p, c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

// the bubble: an ellipse and its tail at the bottom left
function inBubble (x, y) {
  if (((x - 32) / 20.5) ** 2 + ((y - 30.3) / 17.8) ** 2 <= 1) return true
  return inTriangle([x, y], [19.5, 41], [16.6, 52], [28, 46.5])
}

function distToSegment (x, y, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
}

function sample (px, py) {
  const x = px / U; const y = py / U
  if (!inRoundedSquare(x, y)) return null
  if (!inBubble(x, y)) return grad(x, y)
  for (const [nx, ny] of NODES) if (Math.hypot(x - nx, y - ny) <= 4.6) return grad(x, y)
  for (let i = 0; i < 3; i++) if (distToSegment(x, y, NODES[i], NODES[(i + 1) % 3]) <= 1.5) return grad(x, y)
  return INK
}

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  for (let x = 0; x < S; x++) {
    let r = 0; let g = 0; let b = 0; let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const col = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
        if (!col) continue
        r += col[0]; g += col[1]; b += col[2]; a++
      }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4
    if (a) { raw[o] = r / a; raw[o + 1] = g / a; raw[o + 2] = b / a }
    raw[o + 3] = Math.round((a / (SS * SS)) * 255)
  }
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
const out = path.join(__dirname, '..', 'build', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
