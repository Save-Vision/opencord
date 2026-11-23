// Profile picture picker: choose an image, drag/zoom it inside a circle, export a small WebP.
// The result is a data URL that travels inside your signed profile op, so friends see it
// even when you're offline. It must stay under the 48 KB limit enforced by store.js and model.js.
import { html, useState, useRef } from '../vendor/preact-htm.js'
import { model } from '../lib/core.js'

const VIEW = 240 // crop viewport, px
const MAX_CHARS = 46 * 1024
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp'

// Decode the file once and shrink it, so huge photos stay snappy while cropping.
export async function loadImageForCrop (file) {
  if (file.size > 40 * 1024 * 1024) throw new Error('That image is too large (max 40 MB)')
  let bmp
  try { bmp = await createImageBitmap(file) } catch { throw new Error("Couldn't read that image. Try a PNG, JPEG or WebP.") }
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()
  return { canvas, w, h, src: canvas.toDataURL('image/webp', 0.92) }
}

// Render the visible circle area at 256 px (falling back to smaller sizes and lower quality)
// until it fits the size limit.
export function exportAvatar (image, { left, top, scale }) {
  for (const size of [256, 192, 128]) {
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    const f = size / VIEW
    ctx.drawImage(image.canvas, left * f, top * f, image.w * scale * f, image.h * scale * f)
    for (const q of [0.9, 0.8, 0.7, 0.55]) {
      const url = c.toDataURL('image/webp', q)
      if (url.startsWith('data:image/webp;base64,') && url.length <= MAX_CHARS) return url
    }
  }
  throw new Error('Could not make that picture small enough')
}

export function AvatarCropper ({ image, onDone, onCancel }) {
  const { w, h } = image
  const base = VIEW / Math.min(w, h) // "cover" scale at zoom 1
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const drag = useRef(null)

  // Keep the image covering the whole viewport.
  const clamp = (o, z) => {
    const s = base * z
    const mx = (w * s - VIEW) / 2
    const my = (h * s - VIEW) / 2
    return { x: Math.max(-mx, Math.min(mx, o.x)), y: Math.max(-my, Math.min(my, o.y)) }
  }
  const scale = base * zoom
  const pos = clamp(off, zoom)
  const left = VIEW / 2 - (w * scale) / 2 + pos.x
  const top = VIEW / 2 - (h * scale) / 2 + pos.y

  const setZ = (z) => {
    z = Math.max(1, Math.min(5, z))
    setZoom(z)
    setOff((o) => clamp(o, z))
  }
  const onDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, o: pos }
  }
  const onMove = (e) => {
    const d = drag.current
    if (d) setOff(clamp({ x: d.o.x + e.clientX - d.x, y: d.o.y + e.clientY - d.y }, zoom))
  }
  const onUp = () => { drag.current = null }
  const onWheel = (e) => { e.preventDefault(); setZ(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) }
  const apply = () => {
    try { onDone(exportAvatar(image, { left, top, scale })) } catch (err) { model.toast(err.message, 'error') }
  }

  return html`
    <div class="avatar-cropper">
      <h4>Drag to position · scroll to zoom</h4>
      <div class="crop-view" style=${{ width: VIEW + 'px', height: VIEW + 'px' }}
        onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onWheel=${onWheel}>
        <img src=${image.src} alt="" draggable="false"
          style=${{ left: left + 'px', top: top + 'px', width: w * scale + 'px', height: h * scale + 'px' }} />
        <div class="crop-mask" />
      </div>
      <div class="crop-zoom">
        <span>−</span>
        <input type="range" min="1" max="5" step="0.01" value=${zoom} aria-label="Zoom" onInput=${(e) => setZ(+e.target.value)} />
        <span>+</span>
      </div>
      <div class="row center">
        <button class="btn" onClick=${onCancel}>Cancel</button>
        <button class="btn primary" onClick=${apply}>Apply</button>
      </div>
    </div>`
}

// A hidden file input plus a function that opens it. Calls onImage with the decoded image.
export function useImagePicker (onImage) {
  const ref = useRef()
  const input = html`
    <input type="file" accept=${ACCEPT} hidden ref=${ref}
      onChange=${async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        try { onImage(await loadImageForCrop(f)) } catch (err) { model.toast(err.message, 'error') }
      }} />`
  return [input, () => ref.current?.click()]
}
