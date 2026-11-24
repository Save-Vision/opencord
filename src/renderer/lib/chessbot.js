// The computer opponent for chess: a small alpha-beta search on top of chess.js.
//   Easy    looks one move ahead with a lot of noise: it hangs pieces and misses tactics
//   Medium  two moves ahead plus captures, a little noise: punishes blunders, still beatable
//   Hard    thinks up to five moves ahead (about 1.5 s), plays solid chess for a club player
// No DOM here: it runs in a Web Worker (chessbot-worker.js) and in the headless tests.

import { START, fromFen, legalMoves, play, inCheck, findMove } from './chess.js'

export const BOT_LEVELS = [
  { id: 1, name: 'Easy', hint: 'Makes mistakes. Good for learning.' },
  { id: 2, name: 'Medium', hint: 'Sees simple tactics.' },
  { id: 3, name: 'Hard', hint: 'Thinks several moves ahead.' }
]
export const botLevelName = (id) => BOT_LEVELS.find(l => l.id === id)?.name || 'Medium'

const MATE = 100000
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }

// Piece-square tables (the "simplified evaluation function"), from White's side, a8 first
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  kEnd: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50]
}

// A small opening book, so games against the computer don't all start the same way
const BOOK = {
  '': ['e2e4', 'd2d4', 'c2c4', 'g1f3'],
  e2e4: ['e7e5', 'c7c5', 'e7e6', 'c7c6'],
  d2d4: ['d7d5', 'g8f6', 'e7e6'],
  c2c4: ['e7e5', 'g8f6', 'c7c5'],
  g1f3: ['d7d5', 'g8f6', 'c7c5']
}

// The position's score in centipawns, from the side to move's point of view
export function evaluate (p) {
  const b = p.b
  let mat = { w: 0, b: 0 }
  let pst = 0
  let queens = 0
  let kings = { w: -1, b: -1 }
  for (let i = 0; i < 64; i++) {
    const pc = b[i]
    if (!pc) continue
    const t = pc.toLowerCase()
    const white = pc !== t
    if (t === 'k') { kings[white ? 'w' : 'b'] = i; continue }
    if (t === 'q') queens++
    if (t !== 'p') mat[white ? 'w' : 'b'] += VAL[t]
    const idx = white ? (7 - (i >> 3)) * 8 + (i & 7) : i
    pst += (white ? 1 : -1) * (VAL[t] + PST[t][idx])
  }
  const end = queens === 0 || mat.w + mat.b <= 2600
  for (const c of ['w', 'b']) {
    const i = kings[c]
    if (i < 0) continue
    const idx = c === 'w' ? (7 - (i >> 3)) * 8 + (i & 7) : i
    pst += (c === 'w' ? 1 : -1) * (end ? PST.kEnd : PST.k)[idx]
  }
  // Winning endgames: drive the lone king to the edge and walk ours up to it, so a won
  // position actually gets mated instead of shuffled around until the 50-move rule
  if (end && kings.w >= 0 && kings.b >= 0 && Math.abs(pst) >= 400) {
    const strong = pst > 0 ? 'w' : 'b'
    const weak = strong === 'w' ? 'b' : 'w'
    const k = kings[weak]
    const center = Math.max(3 - (k & 7), (k & 7) - 4) + Math.max(3 - (k >> 3), (k >> 3) - 4)
    const near = 14 - (Math.abs((k & 7) - (kings[strong] & 7)) + Math.abs((k >> 3) - (kings[strong] >> 3)))
    pst += (strong === 'w' ? 1 : -1) * (center * 10 + near * 4)
  }
  return p.turn === 'w' ? pst : -pst
}

const keyOf = (p) => p.b.map(x => x || '.').join('') + p.turn + p.castle + p.ep

// Captures first (most valuable victim, least valuable attacker), then promotions
function ordered (p, moves, killer) {
  const score = (m) => {
    const victim = p.b[m.to] || (m.flag === 'ep' ? 'p' : null)
    let s = 0
    if (victim) s += 10 * VAL[victim.toLowerCase()] + 1000 - VAL[p.b[m.from].toLowerCase()] / 10
    if (m.promo) s += VAL[m.promo] + 900
    if (killer && m.from === killer.from && m.to === killer.to) s += 500
    return s
  }
  return moves.map(m => [score(m), m]).sort((a, b) => b[0] - a[0]).map(x => x[1])
}

class Timeout extends Error {}

function quiesce (p, alpha, beta, ply, ctx, qd) {
  ctx.nodes++
  const moves = legalMoves(p)
  const check = inCheck(p)
  if (!moves.length) return check ? -MATE + ply : 0
  const stand = evaluate(p)
  if (!check) {
    if (stand >= beta) return stand
    if (stand > alpha) alpha = stand
  }
  if (qd >= ctx.qMax) return stand
  const list = check ? moves : moves.filter(m => p.b[m.to] || m.flag === 'ep' || m.promo === 'q')
  for (const m of ordered(p, list)) {
    const s = -quiesce(play(p, m), -beta, -alpha, ply + 1, ctx, qd + 1)
    if (s >= beta) return s
    if (s > alpha) alpha = s
  }
  return alpha
}

function search (p, depth, alpha, beta, ply, ctx, path) {
  ctx.nodes++
  if ((ctx.nodes & 511) === 0 && Date.now() > ctx.deadline) throw new Timeout()
  const key = keyOf(p)
  if (ply > 0 && (path.includes(key) || ctx.history.has(key))) return 0 // a repetition: a draw
  if (p.half >= 100) return 0
  if (depth <= 0 && ctx.qMax) return quiesce(p, alpha, beta, ply, ctx, 0)
  const moves = legalMoves(p)
  if (!moves.length) return inCheck(p) ? -MATE + ply : 0
  if (depth <= 0) return evaluate(p)
  path.push(key)
  let best = -Infinity
  try {
    for (const m of ordered(p, moves, ctx.killers[ply])) {
      const s = -search(play(p, m), depth - 1, -beta, -alpha, ply + 1, ctx, path)
      if (s > best) best = s
      if (s > alpha) alpha = s
      if (alpha >= beta) {
        if (!p.b[m.to]) ctx.killers[ply] = m
        break
      }
    }
  } finally {
    path.pop()
  }
  return best
}

// Scores of every root move at one depth (a full window for each, so the weaker levels can
// pick among good-enough moves)
function scoreAll (p, moves, depth, ctx) {
  const path = [keyOf(p)]
  return moves.map(m => ({ m, s: -search(play(p, m), depth - 1, -MATE - 1, MATE + 1, 1, ctx, path) }))
}

// The best root move at one depth, alpha-beta at the root too (for Hard)
function bestAt (p, moves, depth, ctx) {
  const path = [keyOf(p)]
  let alpha = -MATE - 1
  let best = null
  for (const m of moves) {
    const s = -search(play(p, m), depth - 1, -MATE - 1, -alpha, 1, ctx, path)
    if (!best || s > best.s) best = { m, s }
    if (s > alpha) alpha = s
  }
  return best
}

const gauss = (rng) => {
  let u = 0
  let v = 0
  while (!u) u = rng()
  while (!v) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// p: the position; level 1..3; history: position keys seen in the game so far (for repetitions)
// book: the game's first move ('' before any), to answer from the opening book; null = no book
export function chooseMove (p, { level = 2, history = [], rng = Math.random, timeMs = 1500, book = null } = {}) {
  const moves = legalMoves(p)
  if (!moves.length) return null
  if (moves.length === 1) return moves[0]
  if (book != null && book in BOOK) {
    const ideas = BOOK[book].map(u => findMove(p, u, moves)).filter(Boolean)
    if (ideas.length) return ideas[Math.floor(rng() * ideas.length)]
  }
  const ctx = { nodes: 0, deadline: Date.now() + timeMs, history: new Set(history), killers: [], qMax: 0 }
  if (level <= 1) {
    // a beginner: one move deep, no follow-up captures, quite random (but it does see mate in one)
    const scored = scoreAll(p, moves, 1, { ...ctx, deadline: Infinity })
    const mate = scored.find(x => x.s > MATE - 100)
    if (mate) return mate.m
    if (rng() < 0.12) return moves[Math.floor(rng() * moves.length)]
    return pickNoisy(scored, 90, rng)
  }
  if (level === 2) {
    const scored = scoreAll(p, ordered(p, moves), 2, { ...ctx, qMax: 4, deadline: Infinity })
    return pickNoisy(scored, 25, rng)
  }
  // Hard: deeper and deeper until the time is up, the best move of the deepest finished search
  ctx.qMax = 6
  let order = ordered(p, moves)
  let best = { m: order[0], s: -MATE }
  for (let depth = 1; depth <= 5; depth++) {
    try {
      best = bestAt(p, order, depth, ctx)
    } catch (e) {
      if (e instanceof Timeout) break
      throw e
    }
    if (Math.abs(best.s) > MATE - 100) break // a forced mate found
    order = [best.m, ...order.filter(m => m !== best.m)]
  }
  return best.m
}

function pickNoisy (scored, sigma, rng) {
  let best = null
  for (const x of scored) {
    // never miss a mate in one, and never walk into one
    const s = Math.abs(x.s) > MATE - 100 ? x.s : x.s + gauss(rng) * sigma
    if (!best || s > best.s) best = { m: x.m, s }
  }
  return best.m
}

// For the worker: the game's moves so far (UCI) -> the computer's move (UCI), or null
export function botReply (ucis, level, opts = {}) {
  let p = fromFen(START)
  const history = [keyOf(p)]
  for (const u of ucis) {
    const m = findMove(p, u)
    if (!m) return null
    p = play(p, m)
    history.push(keyOf(p))
  }
  const book = ucis.length === 0 ? '' : ucis.length === 1 ? ucis[0] : null
  const m = chooseMove(p, { level, history, book, ...opts })
  return m ? uciOf(m) : null
}

const FILES = 'abcdefgh'
const uciOf = (m) => FILES[m.from & 7] + ((m.from >> 3) + 1) + FILES[m.to & 7] + ((m.to >> 3) + 1) + (m.promo || '')
