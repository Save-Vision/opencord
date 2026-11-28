// Notices when a screen share stays black.
//
// Netflix, Disney+, Prime Video and most other streaming sites protect their films: Windows and
// the browser leave the picture out of every screen capture (in any app, Discord too), so
// friends see black where the film plays. OpenDiscord can't and doesn't get around that. It
// only notices that what you share stays black and tells you what helps: with the browser's
// graphics acceleration off, the browser plays the film itself, without the protected path
// through the graphics card, and it shows up in captures (often in lower quality).

export const BLACK = 0.55 // at least this share of the picture is black...
export const CLEAR = 0.3 // ...and it counts as fine again below this
const SIZE = [64, 36]

// The share of pixels that are black (RGBA bytes). Protected video is pure black, not dark grey.
export function blackShare (data) {
  let black = 0
  let n = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    n++
    if (data[i] <= 3 && data[i + 1] <= 3 && data[i + 2] <= 3) black++
  }
  return n ? black / n : 0
}

// Which browser a shared window belongs to, from its title ("Netflix - Google Chrome")
export function browserOf (name) {
  const s = String(name || '').replace(/[​-‍﻿]/g, '').trim()
  if (/google chrome$/i.test(s)) return 'chrome'
  if (/microsoft edge$/i.test(s)) return 'edge'
  if (/firefox$/i.test(s)) return 'firefox'
  if (/\bbrave$/i.test(s)) return 'brave'
  if (/\bopera$/i.test(s)) return 'opera'
  return null
}

// Samples the shared picture every couple of seconds; calls onChange(true) once it has been
// black for `need` samples in a row, and onChange(false) when it isn't any more.
export class BlackWatch {
  constructor (onChange, { every = 2000, need = 4 } = {}) {
    this.onChange = onChange
    this.every = every
    this.need = need
    this.black = false
    this.hits = 0
    this.video = null
    this.timer = null
    this.canvas = null
  }

  start (track) {
    this.stop()
    if (!track) return
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.srcObject = new MediaStream([track])
    v.play().catch(() => {})
    this.video = v
    this.timer = setInterval(() => this._sample(), this.every)
  }

  stop () {
    clearInterval(this.timer)
    this.timer = null
    if (this.video) { this.video.srcObject = null; this.video = null }
    this.hits = 0
    if (this.black) { this.black = false; this.onChange(false) }
  }

  _sample () {
    const v = this.video
    if (!v || v.readyState < 2 || !v.videoWidth) return
    if (!this.canvas) {
      this.canvas = document.createElement('canvas')
      this.canvas.width = SIZE[0]
      this.canvas.height = SIZE[1]
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(v, 0, 0, SIZE[0], SIZE[1])
    const f = blackShare(ctx.getImageData(0, 0, SIZE[0], SIZE[1]).data)
    if (f >= BLACK) {
      if (++this.hits >= this.need && !this.black) { this.black = true; this.onChange(true) }
    } else if (f < CLEAR) {
      this.hits = 0
      if (this.black) { this.black = false; this.onChange(false) }
    }
  }
}
