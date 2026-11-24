// The floating blocks of the main window (lib/layout.js explains the layout).
//   - Drag a block by the little grip above it and drop it on the left or right half of
//     another block. The blocks glide into their new places (View Transitions).
//   - Drag the edge of the channels or side block to resize it; widths snap to a few sizes.
//     Double-click the edge to go back to the default width.
//   - Escape cancels a drag. Settings > Appearance can reset everything.
// The blocks always stay in the same DOM order and are placed with CSS `order`, so moving one
// never remounts the chat or loses its scroll position.

import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { model, saveSettings } from '../lib/core.js'
import { BLOCKS, normalizeLayout, moveBlock, sameOrder, dropSide, resizeEdge, dragWidth, SIZES } from '../lib/layout.js'

export const BLOCK_LABEL = { rail: 'Groups', nav: 'Channels', main: 'Chat', side: 'Side panel' }

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Saves a new layout. The DOM is updated inside a view transition so the blocks slide over.
export async function setLayout (layout) {
  const next = normalizeLayout(layout)
  const update = () => {
    model.settings = { ...model.settings, layout: next }
    model.emit()
    // Preact re-renders on a microtask, so the DOM is updated by the next task. (Not
    // requestAnimationFrame: frames are paused while a view transition captures the page.)
    return new Promise(resolve => setTimeout(resolve, 0))
  }
  if (document.startViewTransition && !reduceMotion()) {
    document.documentElement.classList.add('vt-docks')
    const t = document.startViewTransition(update)
    t.finished.finally(() => document.documentElement.classList.remove('vt-docks'))
    await t.updateCallbackDone
  } else {
    await update()
  }
  await saveSettings({ layout: next })
}

export function resetLayout () {
  return setLayout({ order: null, w: {} })
}

export function DockLayout ({ blocks }) {
  const layout = normalizeLayout(model.settings.layout)
  const [live, setLive] = useState(null)
  const liveRef = useRef(null)
  liveRef.current = live

  // Escape cancels a move or resize
  useEffect(() => {
    if (!live) return
    const esc = (e) => { if (e.key === 'Escape') { liveRef.current?.cancel?.(); setLive(null) } }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [!!live])

  const startMove = (id, e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const grip = e.currentTarget
    grip.setPointerCapture?.(e.pointerId)
    const x0 = e.clientX
    const y0 = e.clientY
    let moving = false
    let cancelled = false
    let cur = null
    const onMove = (ev) => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      moving = true
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-dock]')
      const target = el?.dataset.dock
      let where = null
      if (target && target !== id) {
        where = dropSide(el.getBoundingClientRect(), ev.clientX)
        if (sameOrder(moveBlock(layout.order, id, target, where), layout.order)) where = null
      }
      cur = { move: true, id, target: where ? target : null, where, x: ev.clientX, y: ev.clientY, cancel: () => { cancelled = true } }
      setLive(cur)
    }
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeEventListener('pointercancel', onUp)
      setLive(null)
      if (!cancelled && cur?.target) setLayout({ ...layout, order: moveBlock(layout.order, id, cur.target, cur.where) })
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
  }

  const startResize = (id, e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture?.(e.pointerId)
    const startW = handle.parentElement.getBoundingClientRect().width
    const x0 = e.clientX
    let cancelled = false
    let w = null
    const onMove = (ev) => {
      w = dragWidth(layout.order, id, startW, x0, ev.clientX)
      setLive({ resize: true, id, w, cancel: () => { cancelled = true } })
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setLive(null)
      if (!cancelled && w != null && w !== layout.w[id]) {
        // update straight away (no glide: the block is already that wide)
        const next = { ...layout, w: { ...layout.w, [id]: w } }
        model.settings = { ...model.settings, layout: next }
        model.emit()
        saveSettings({ layout: next })
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const resetWidth = (id) => {
    const w = { ...layout.w }
    delete w[id]
    setLayout({ ...layout, w })
  }

  return html`
    <div class="app docks ${live?.move ? 'docking' : ''} ${live?.resize ? 'resizing' : ''}">
      ${BLOCKS.map((id) => {
        const content = blocks[id]
        if (!content) return null
        const order = layout.order.indexOf(id)
        const w = live?.resize && live.id === id ? live.w : layout.w[id]
        const drop = live?.move && live.target === id ? 'drop-' + live.where : ''
        const resizable = !!SIZES[id]
        const edge = resizable ? resizeEdge(layout.order, id) : null
        return html`
          <section key=${id} data-dock=${id}
            class="dock dock-${id} ${w ? 'sized' : ''} ${live?.move && live.id === id ? 'dragging' : ''} ${drop} ${edge ? 'edge-' + edge : ''}"
            style=${{ order, width: w ? w + 'px' : undefined }}>
            <div class="dock-grip" title=${`Drag to move the ${BLOCK_LABEL[id].toLowerCase()} panel`} onPointerDown=${(e) => startMove(id, e)}><i /></div>
            ${resizable && html`<div class="dock-resize ${edge}" title="Drag to resize · double-click for the default width"
              onPointerDown=${(e) => startResize(id, e)} onDblClick=${() => resetWidth(id)} />`}
            ${live?.resize && live.id === id && html`<div class="dock-size">${live.w} px</div>`}
            ${content}
          </section>`
      })}
      ${live?.move && html`
        <div class="dock-ghost ${live.target ? 'ok' : ''}" style=${{ left: live.x + 14 + 'px', top: live.y + 14 + 'px' }}>
          ${BLOCK_LABEL[live.id]}${live.target ? (live.where === 'before' ? ' → left of ' : ' → right of ') + BLOCK_LABEL[live.target].toLowerCase() : ''}
        </div>`}
    </div>`
}
