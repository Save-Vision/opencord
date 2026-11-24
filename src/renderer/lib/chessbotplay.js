// Plays the computer's moves in chess games against it (games.js, info.bot). Only the app of
// whoever started the game does, signing them as its own ops: deriveChess accepts that
// player's moves for the computer's side too. While that app is closed, the game just waits,
// and everyone else can watch it like any other game.
import { model, append } from './core.js'
import { BOT } from './games.js'

let worker = null
const asked = new Map() // 'gid:id:ply' -> { gid, id, n, at, level }
// The fastest a reply comes, so an instant answer doesn't feel like a wall (Hard thinks anyway)
const MIN_THINK = { 1: 700, 2: 800, 3: 300 }

function getWorker () {
  if (worker) return worker
  worker = new Worker(new URL('./chessbot-worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => onReply(e.data || {})
  worker.onerror = (e) => {
    console.warn('chess computer:', e.message)
    worker?.terminate()
    worker = null
    asked.clear()
  }
  return worker
}

function tick () {
  const me = model.me?.key
  if (!me) return
  for (const g of model.groups.values()) {
    if (g.kickedMe || g.restoring) continue
    for (const [id, gm] of g.games) {
      if (gm.info?.kind !== 'chess' || !gm.info.bot || gm.by !== me) continue
      const st = model.gameState(g, id)
      if (!st || st.status !== 'active' || (st.pos.turn === 'w' ? st.white : st.black) !== BOT) continue
      const n = st.plies.length + 1
      const key = `${g.id}:${id}:${n}`
      if (asked.has(key)) continue
      asked.set(key, { gid: g.id, id, n, at: Date.now(), level: st.info.bot })
      getWorker().postMessage({ key, moves: st.plies.map(x => x.uci), level: st.info.bot })
    }
  }
}

async function onReply ({ key, uci }) {
  const q = asked.get(key)
  if (!q || !uci) return
  const wait = (MIN_THINK[q.level] || 600) - (Date.now() - q.at)
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  const g = model.groups.get(q.gid)
  const st = g && model.gameState(g, q.id)
  // still the same position (nobody resigned or cancelled meanwhile)
  if (!st || st.status !== 'active' || st.plies.length + 1 !== q.n) return
  try {
    await append(q.gid, 'game.move', { id: q.id, n: q.n, m: uci })
  } catch {
    asked.delete(key) // try again on the next tick
  }
}

export function startChessBot () {
  let queued = false
  model.subscribe(() => {
    if (queued) return
    queued = true
    setTimeout(() => { queued = false; tick() }, 50)
  })
  setInterval(tick, 3000)
}
