// Chess games played through signed ops, so they sync like messages (live or one move a day).
//
//  msg { game: { kind: 'chess', side, opp, tc } }   starts a game; the message is its card
//  game.join    { id }              takes the free seat (or accepts a challenge)
//  game.decline { id }              the challenged person says no
//  game.move    { id, n, m, left }  ply n (1 = white's first move) as UCI, e.g. 'e2e4', 'e7e8q';
//                                   left = the mover's clock after the move, measured by their app
//  game.resign  { id, n }           n = how many plies the author had seen
//  game.draw    { id, n, no }       offer (or accept) a draw at ply n; no = decline the offer
//  game.flag    { id, n }           the player to move at ply n ran out of time
//  game.abort   { id, n }           cancel before both players moved (or before anyone joined)
//
// Every app replays these the same way: a move only counts if it's legal and comes from the
// player whose turn it is (for one ply, the first such move its author signed wins).

import { START, fromFen, legalMoves, findMove, play, san, outcome, positionKey, uci } from './chess.js'
import { cleanPokerInfo } from './poker.js'

const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)

export const TIME_CONTROLS = [
  { id: 'none', label: 'No clock', hint: 'Take your time, even days', tc: null },
  { id: '3+2', label: '3 + 2', hint: 'Blitz', tc: { base: 3 * 60000, inc: 2000 } },
  { id: '5+0', label: '5 min', hint: 'Blitz', tc: { base: 5 * 60000, inc: 0 } },
  { id: '10+0', label: '10 min', hint: 'Rapid', tc: { base: 10 * 60000, inc: 0 } },
  { id: '15+10', label: '15 + 10', hint: 'Rapid', tc: { base: 15 * 60000, inc: 10000 } }
]

export const tcLabel = (tc) => !tc ? 'No clock' : (tc.base / 60000) + (tc.inc ? ' + ' + tc.inc / 1000 : ' min')

export function cleanGameInfo (d) {
  if (d && typeof d === 'object' && d.kind === 'poker') return cleanPokerInfo(d)
  if (!d || typeof d !== 'object' || d.kind !== 'chess') return null
  let tc = null
  if (d.tc && typeof d.tc === 'object' && Number.isFinite(d.tc.base) && d.tc.base >= 30000 && d.tc.base <= 3 * 3600000) {
    tc = { base: Math.round(d.tc.base), inc: Math.max(0, Math.min(60000, Math.round(Number(d.tc.inc) || 0))) }
  }
  return { kind: 'chess', side: d.side === 'b' ? 'b' : 'w', opp: isKey(d.opp) ? d.opp : null, tc }
}

export const REASONS = {
  checkmate: 'checkmate',
  stalemate: 'stalemate',
  insufficient: 'not enough pieces to mate',
  fifty: '50 moves without a capture or pawn move',
  repetition: 'the same position three times',
  resign: 'resignation',
  time: 'time',
  agreement: 'agreement',
  aborted: 'cancelled',
  declined: 'declined'
}

const order = (x, y) => x.t - y.t || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.s - y.s)

// game: { info, by, ops: [{ k, a, s, t, n, m, left, no, recv }] } -> the state everyone agrees on
export function deriveChess (game) {
  const { info, by } = game
  const st = {
    info,
    by,
    white: null,
    black: null,
    status: 'open', // 'open' (waiting for an opponent) | 'active' | 'over'
    result: null, // '1-0' | '0-1' | '1/2-1/2' | null (aborted / declined)
    reason: null,
    plies: [],
    pos: fromFen(START),
    drawOffer: null, // key of the player offering a draw right now
    drawDeclined: false,
    clock: null // { w, b, running, since }: ms left, side whose clock runs, local time it started
  }
  if (!info) { st.status = 'missing'; return st }
  if (info.side === 'w') st.white = by
  else st.black = by
  const seat = (side) => (side === 'w' ? st.white : st.black)
  const player = (a) => a === st.white || a === st.black

  // 1. Until someone takes the free seat: joins, the creator cancelling, the challenged declining
  for (const o of game.ops.filter(o => o.k === 'join' || o.k === 'abort' || o.k === 'decline').sort(order)) {
    if (o.k === 'join' && o.a !== by && (!info.opp || o.a === info.opp)) {
      if (info.side === 'w') st.black = o.a
      else st.white = o.a
      st.status = 'active'
      st.joinedAt = o.recv
      break
    }
    if (o.k === 'abort' && o.a === by) { Object.assign(st, { status: 'over', reason: 'aborted' }); return st }
    if (o.k === 'decline' && o.a === info.opp) { Object.assign(st, { status: 'over', reason: 'declined' }); return st }
  }
  if (st.status === 'open') return st

  // 2. Moves, ply by ply, with resign / draw / flag / abort claims checked at each ply count
  const moves = new Map()
  const claims = new Map()
  for (const o of game.ops) {
    if (!Number.isInteger(o.n) || o.n < 0 || o.n > 2000) continue
    const map = o.k === 'move' ? moves : ['resign', 'draw', 'flag', 'abort'].includes(o.k) ? claims : null
    if (!map) continue
    if (!map.has(o.n)) map.set(o.n, [])
    map.get(o.n).push(o)
  }
  const left = info.tc ? { w: info.tc.base, b: info.tc.base } : null
  let p = st.pos
  const keys = [positionKey(p)]
  let k = 0
  const end = (result, reason) => Object.assign(st, { status: 'over', result, reason })
  const settle = () => {
    // claims made when k plies had been played, in the order they were made
    const offers = new Set()
    st.drawOffer = null
    st.drawDeclined = false
    for (const o of (claims.get(k) || []).sort(order)) {
      if (!player(o.a)) continue
      const side = o.a === st.white ? 'w' : 'b'
      if (o.k === 'resign') { end(side === 'w' ? '0-1' : '1-0', 'resign'); return true }
      if (o.k === 'abort' && k < 2) { end(null, 'aborted'); return true }
      if (o.k === 'flag' && left && k >= 2) { end(p.turn === 'w' ? '0-1' : '1-0', 'time'); return true }
      if (o.k === 'draw') {
        if (o.no) {
          // the other player says no: that offer is gone
          if (st.drawOffer && st.drawOffer !== o.a) { offers.delete(st.drawOffer); st.drawOffer = null; st.drawDeclined = true }
          continue
        }
        offers.add(o.a)
        if (offers.has(st.white) && offers.has(st.black)) { end('1/2-1/2', 'agreement'); return true }
        st.drawOffer = o.a
        st.drawDeclined = false
      }
    }
    return false
  }
  while (!settle()) {
    const mover = seat(p.turn)
    const legal = legalMoves(p)
    let chosen = null
    let mv = null
    for (const o of (moves.get(k + 1) || []).filter(o => o.a === mover).sort((x, y) => x.s - y.s)) {
      mv = findMove(p, o.m, legal)
      if (mv) { chosen = o; break }
    }
    if (!mv) break
    const side = p.turn
    const next = play(p, mv)
    st.plies.push({ uci: uci(mv), san: san(p, mv, legal), from: mv.from, to: mv.to, a: chosen.a, t: chosen.t, recv: chosen.recv, captured: next.captured })
    if (left && k >= 2 && Number.isFinite(chosen.left)) left[side] = Math.max(0, Math.min(chosen.left, 24 * 3600000))
    p = next
    keys.push(positionKey(p))
    k++
    const out = outcome(p, keys)
    if (out) { end(out.result, out.reason); break }
  }
  st.pos = p
  if (left) {
    const running = st.status === 'active' && k >= 2 ? p.turn : null
    st.clock = { w: left.w, b: left.b, running, since: k ? st.plies[k - 1].recv : st.joinedAt }
  }
  return st
}

// ms left on a side's clock right now (negative once it ran out)
export function clockLeft (st, side, now = Date.now()) {
  if (!st.clock) return null
  const base = st.clock[side]
  return st.clock.running === side ? base - (now - st.clock.since) : base
}

export function winnerOf (st) {
  if (st.result === '1-0') return st.white
  if (st.result === '0-1') return st.black
  return null
}

// The ops for me playing a move right now: what to send as `left`
export function moveLeft (st, side, now = Date.now()) {
  if (!st.info.tc) return undefined
  if (st.plies.length < 2) return st.info.tc.base
  return Math.max(0, Math.round(clockLeft(st, side, now))) + st.info.tc.inc
}
