// The window is made of four floating blocks, side by side:
//   rail  the group icons      nav   channels or private chats
//   main  chat, call, games    side  members, thread or search
// Like the panels in VS Code they can be dragged into another order (drop on the left or right
// half of another block) and the nav and side blocks can be resized; widths snap to a few
// comfortable sizes. The layout is saved in settings.layout (views/dock.js draws it).

export const BLOCKS = ['rail', 'nav', 'main', 'side']
export const DEFAULT_ORDER = ['rail', 'nav', 'main', 'side']

// Width limits and the widths a resize snaps to (within SNAP px)
export const SIZES = {
  nav: { min: 200, max: 420, snaps: [220, 248, 280, 320, 360] },
  side: { min: 240, max: 560, snaps: [240, 300, 360, 420, 480] }
}
export const SNAP = 14

export function normalizeLayout (l) {
  const order = Array.isArray(l?.order) && l.order.length === BLOCKS.length && BLOCKS.every(b => l.order.includes(b))
    ? [...l.order]
    : [...DEFAULT_ORDER]
  const w = {}
  for (const id of Object.keys(SIZES)) {
    const v = Number(l?.w?.[id])
    if (Number.isFinite(v) && v > 0) w[id] = clampWidth(id, v)
  }
  return { order, w }
}

export function clampWidth (id, px) {
  const s = SIZES[id]
  return s ? Math.round(Math.min(s.max, Math.max(s.min, px))) : px
}

// While resizing: the nearest snap width when close to one, else the width itself
export function snapWidth (id, px) {
  const s = SIZES[id]
  if (!s) return px
  const v = clampWidth(id, px)
  let best = null
  for (const p of s.snaps) if (Math.abs(p - v) <= SNAP && (best === null || Math.abs(p - v) < Math.abs(best - v))) best = p
  return best ?? v
}

// Moves block `id` next to `target`: 'before' = to its left, 'after' = to its right
export function moveBlock (order, id, target, where) {
  if (!order.includes(id) || !order.includes(target) || id === target) return [...order]
  const out = order.filter(b => b !== id)
  const i = out.indexOf(target) + (where === 'after' ? 1 : 0)
  out.splice(i, 0, id)
  return out
}

export const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// Which half of a block the pointer is over
export const dropSide = (rect, x) => x < rect.left + rect.width / 2 ? 'before' : 'after'

// A resizable block's handle sits on the edge that faces the main block
export function resizeEdge (order, id) {
  return order.indexOf(id) < order.indexOf('main') ? 'right' : 'left'
}

// New width from a drag that started at startX with width startW
export function dragWidth (order, id, startW, startX, x) {
  const dx = x - startX
  return snapWidth(id, resizeEdge(order, id) === 'right' ? startW + dx : startW - dx)
}
