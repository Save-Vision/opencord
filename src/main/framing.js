'use strict'
// Length-prefixed frames over the encrypted Hyperswarm stream.
// frame := u32be length | u8 kind | payload
//   kind 0 = JSON control message
//   kind 1 = binary blob chunk: u32be transferId | bytes

const KIND_JSON = 0
const KIND_BLOB = 1
const MAX_FRAME = 32 * 1024 * 1024

function encodeJSON (obj) {
  const body = Buffer.from(JSON.stringify(obj))
  const out = Buffer.allocUnsafe(5 + body.length)
  out.writeUInt32BE(body.length + 1, 0)
  out[4] = KIND_JSON
  body.copy(out, 5)
  return out
}

function encodeBlobChunk (transferId, data) {
  const out = Buffer.allocUnsafe(9 + data.length)
  out.writeUInt32BE(data.length + 5, 0)
  out[4] = KIND_BLOB
  out.writeUInt32BE(transferId >>> 0, 5)
  data.copy(out, 9)
  return out
}

class FrameParser {
  constructor (onFrame) {
    this.onFrame = onFrame
    this.chunks = []
    this.len = 0
    this.need = -1
  }

  _take (n) {
    const first = this.chunks[0]
    if (first.length >= n) {
      const out = first.subarray(0, n)
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      this.len -= n
      return out
    }
    const all = Buffer.concat(this.chunks, this.len)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.len = rest.length
    return all.subarray(0, n)
  }

  push (chunk) {
    this.chunks.push(chunk)
    this.len += chunk.length
    for (;;) {
      if (this.need < 0) {
        if (this.len < 4) return
        this.need = this._take(4).readUInt32BE(0)
        if (this.need < 1 || this.need > MAX_FRAME) throw new Error('Invalid frame length ' + this.need)
      }
      if (this.len < this.need) return
      const frame = this._take(this.need)
      this.need = -1
      const kind = frame[0]
      if (kind === KIND_JSON) {
        this.onFrame({ kind: 'json', msg: JSON.parse(frame.subarray(1).toString()) })
      } else if (kind === KIND_BLOB) {
        this.onFrame({ kind: 'blob', id: frame.readUInt32BE(1), data: frame.subarray(5) })
      } else {
        throw new Error('Unknown frame kind ' + kind)
      }
    }
  }
}

module.exports = { encodeJSON, encodeBlobChunk, FrameParser, MAX_FRAME }
