'use strict'
// Renders build/icon.png (512×512): three overlapping circles — you and your two friends.
// Pure Node, no dependencies. Run: node scripts/make-icon.js
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const S = 512
const SS = 4 // supersampling per axis
const bg = [14, 15, 18]
const circles = [
  { x: 168, y: 284, r: 112, c: [45, 212, 191] },
  { x: 344, y: 284, r: 112, c: [251, 191, 36] },
  { x: 256, y: 212, r: 112, c: [244, 114, 182] }
]
const ring = 16 // dark gap between circles

function inRoundedSquare (x, y) {
  const m = 16
  const rad = 112
  const lo = m + rad
  const hi = S - m - rad
  const cx = Math.min(Math.max(x, lo), hi)
  const cy = Math.min(Math.max(y, lo), hi)
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
}

function sample (x, y) {
  if (!inRoundedSquare(x, y)) return null
  // draw back-to-front; later circles get a dark ring that cuts the earlier ones
  let col = bg
  for (const c of circles) {
    const d = Math.hypot(x - c.x, y - c.y)
    if (d <= c.r + ring) col = d <= c.r ? c.c : bg
  }
  return col
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
