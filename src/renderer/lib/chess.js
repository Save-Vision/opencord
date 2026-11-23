// The rules of chess: legal moves, SAN notation, check, mate and draws. Squares are 0..63
// with a1 = 0, h1 = 7, a8 = 56. Pieces are FEN letters: white upper case, black lower case.
// No DOM here, so the headless tests can run it (perft counts in test/core.test.js).

const FILES = 'abcdefgh'
export const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const N_OFF = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const K_OFF = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const B_DIR = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const R_DIR = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const Q_DIR = [...B_DIR, ...R_DIR]

export const sqName = (i) => FILES[i & 7] + ((i >> 3) + 1)
export const sqIndex = (s) => (/^[a-h][1-8]$/.test(s) ? FILES.indexOf(s[0]) + (Number(s[1]) - 1) * 8 : -1)
export const colorOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null)
const other = (c) => (c === 'w' ? 'b' : 'w')
const at = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1)

export function fromFen (fen = START) {
  const [placement, turn, castle, ep, half, full] = String(fen).trim().split(/\s+/)
  const b = new Array(64).fill(null)
  const rows = placement.split('/')
  for (let r = 0; r < 8; r++) {
    let f = 0
    for (const ch of rows[7 - r] || '') {
      if (/\d/.test(ch)) f += Number(ch)
      else b[r * 8 + f++] = ch
    }
  }
  return {
    b,
    turn: turn === 'b' ? 'b' : 'w',
    castle: !castle || castle === '-' ? '' : castle,
    ep: ep && ep !== '-' ? sqIndex(ep) : -1,
    half: Number(half) || 0,
    full: Number(full) || 1
  }
}

export function toFen (p) {
  const rows = []
  for (let r = 7; r >= 0; r--) {
    let row = ''
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const pc = p.b[r * 8 + f]
      if (!pc) { empty++; continue }
      if (empty) { row += empty; empty = 0 }
      row += pc
    }
    rows.push(row + (empty || ''))
  }
  return `${rows.join('/')} ${p.turn} ${p.castle || '-'} ${p.ep >= 0 ? sqName(p.ep) : '-'} ${p.half} ${p.full}`
}

// Is square `sq` attacked by side `by`?
function attacked (b, sq, by) {
  const f = sq & 7
  const r = sq >> 3
  const up = by === 'w'
  const pawn = up ? 'P' : 'p'
  const pr = up ? r - 1 : r + 1
  for (const df of [-1, 1]) { const i = at(f + df, pr); if (i >= 0 && b[i] === pawn) return true }
  const knight = up ? 'N' : 'n'
  for (const [df, dr] of N_OFF) { const i = at(f + df, r + dr); if (i >= 0 && b[i] === knight) return true }
  const king = up ? 'K' : 'k'
  for (const [df, dr] of K_OFF) { const i = at(f + df, r + dr); if (i >= 0 && b[i] === king) return true }
  const queen = up ? 'Q' : 'q'
  const rook = up ? 'R' : 'r'
  const bishop = up ? 'B' : 'b'
  for (const [dirs, piece] of [[R_DIR, rook], [B_DIR, bishop]]) {
    for (const [df, dr] of dirs) {
      let x = f + df
      let y = r + dr
      while (x >= 0 && x < 8 && y >= 0 && y < 8) {
        const p = b[y * 8 + x]
        if (p) { if (p === piece || p === queen) return true; break }
        x += df
        y += dr
      }
    }
  }
  return false
}

const kingSq = (b, c) => b.indexOf(c === 'w' ? 'K' : 'k')

export function inCheck (p) {
  const k = kingSq(p.b, p.turn)
  return k >= 0 && attacked(p.b, k, other(p.turn))
}

// Moves that follow the pieces' rules, before checking that our king is safe afterwards
function pseudoMoves (p) {
  const out = []
  const { b, turn } = p
  const opp = other(turn)
  const add = (from, to, promote) => {
    if (promote) for (const q of 'qrbn') out.push({ from, to, promo: q })
    else out.push({ from, to })
  }
  for (let i = 0; i < 64; i++) {
    const pc = b[i]
    if (!pc || colorOf(pc) !== turn) continue
    const f = i & 7
    const r = i >> 3
    const t = pc.toLowerCase()
    if (t === 'p') {
      const dir = turn === 'w' ? 1 : -1
      const last = turn === 'w' ? 7 : 0
      const one = at(f, r + dir)
      if (one >= 0 && !b[one]) {
        add(i, one, r + dir === last)
        const two = at(f, r + 2 * dir)
        if (r === (turn === 'w' ? 1 : 6) && !b[two]) out.push({ from: i, to: two, flag: 'double' })
      }
      for (const df of [-1, 1]) {
        const x = at(f + df, r + dir)
        if (x < 0) continue
        if (b[x] && colorOf(b[x]) === opp) add(i, x, r + dir === last)
        else if (x === p.ep && !b[x]) out.push({ from: i, to: x, flag: 'ep' })
      }
    } else if (t === 'n' || t === 'k') {
      for (const [df, dr] of t === 'n' ? N_OFF : K_OFF) {
        const x = at(f + df, r + dr)
        if (x >= 0 && colorOf(b[x]) !== turn) out.push({ from: i, to: x })
      }
      if (t === 'k') {
        const home = turn === 'w' ? 4 : 60
        const [K, Q, R] = turn === 'w' ? ['K', 'Q', 'R'] : ['k', 'q', 'r']
        if (i === home && !attacked(b, home, opp)) {
          if (p.castle.includes(K) && b[home + 3] === R && !b[home + 1] && !b[home + 2] &&
            !attacked(b, home + 1, opp) && !attacked(b, home + 2, opp)) out.push({ from: i, to: home + 2, flag: 'castle' })
          if (p.castle.includes(Q) && b[home - 4] === R && !b[home - 1] && !b[home - 2] && !b[home - 3] &&
            !attacked(b, home - 1, opp) && !attacked(b, home - 2, opp)) out.push({ from: i, to: home - 2, flag: 'castle' })
        }
      }
    } else {
      for (const [df, dr] of t === 'b' ? B_DIR : t === 'r' ? R_DIR : Q_DIR) {
        let x = f + df
        let y = r + dr
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const j = y * 8 + x
          if (b[j]) { if (colorOf(b[j]) === opp) out.push({ from: i, to: j }); break }
          out.push({ from: i, to: j })
          x += df
          y += dr
        }
      }
    }
  }
  return out
}

// The position after a move (doesn't check that the move is legal)
export function play (p, m) {
  const b = p.b.slice()
  const pc = b[m.from]
  const t = pc.toLowerCase()
  const back = p.turn === 'w' ? -8 : 8
  const captured = m.flag === 'ep' ? b[m.to + back] : b[m.to]
  b[m.to] = m.promo ? (p.turn === 'w' ? m.promo.toUpperCase() : m.promo) : pc
  b[m.from] = null
  if (m.flag === 'ep') b[m.to + back] = null
  if (m.flag === 'castle') {
    const kingSide = m.to > m.from
    const rookFrom = kingSide ? m.from + 3 : m.from - 4
    const rookTo = kingSide ? m.from + 1 : m.from - 1
    b[rookTo] = b[rookFrom]
    b[rookFrom] = null
  }
  let castle = p.castle
  if (t === 'k') castle = castle.replace(p.turn === 'w' ? /[KQ]/g : /[kq]/g, '')
  for (const sq of [m.from, m.to]) {
    if (sq === 0) castle = castle.replace('Q', '')
    if (sq === 7) castle = castle.replace('K', '')
    if (sq === 56) castle = castle.replace('q', '')
    if (sq === 63) castle = castle.replace('k', '')
  }
  return {
    b,
    turn: other(p.turn),
    castle,
    ep: m.flag === 'double' ? (m.from + m.to) / 2 : -1,
    half: t === 'p' || captured ? 0 : p.half + 1,
    full: p.turn === 'b' ? p.full + 1 : p.full,
    captured: captured || null
  }
}

export function legalMoves (p) {
  return pseudoMoves(p).filter((m) => {
    const n = play(p, m)
    const k = kingSq(n.b, p.turn)
    return k >= 0 && !attacked(n.b, k, n.turn)
  })
}

export const uci = (m) => sqName(m.from) + sqName(m.to) + (m.promo || '')

// A legal move given as 'e2e4' / 'e7e8q', or null
export function findMove (p, s, legal = legalMoves(p)) {
  if (typeof s !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(s)) return null
  const from = sqIndex(s.slice(0, 2))
  const to = sqIndex(s.slice(2, 4))
  const promo = s[4] || undefined
  return legal.find(m => m.from === from && m.to === to && m.promo === promo) || null
}

export function san (p, m, legal = legalMoves(p)) {
  const pc = p.b[m.from]
  const t = pc.toLowerCase()
  let s
  if (m.flag === 'castle') {
    s = m.to > m.from ? 'O-O' : 'O-O-O'
  } else {
    const cap = !!p.b[m.to] || m.flag === 'ep'
    if (t === 'p') {
      s = (cap ? FILES[m.from & 7] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '')
    } else {
      const rivals = legal.filter(o => o.to === m.to && o.from !== m.from && p.b[o.from] === pc)
      let dis = ''
      if (rivals.length) {
        if (!rivals.some(o => (o.from & 7) === (m.from & 7))) dis = FILES[m.from & 7]
        else if (!rivals.some(o => (o.from >> 3) === (m.from >> 3))) dis = String((m.from >> 3) + 1)
        else dis = sqName(m.from)
      }
      s = t.toUpperCase() + dis + (cap ? 'x' : '') + sqName(m.to)
    }
  }
  const n = play(p, m)
  if (inCheck(n)) s += legalMoves(n).length ? '+' : '#'
  return s
}

// Only kings, or a king and one minor piece, or bishops all on the same colour: nobody can mate
function insufficient (b) {
  const rest = []
  for (let i = 0; i < 64; i++) if (b[i] && b[i].toLowerCase() !== 'k') rest.push([b[i].toLowerCase(), i])
  if (!rest.length) return true
  if (rest.some(([t]) => t === 'p' || t === 'r' || t === 'q')) return false
  if (rest.length === 1) return true
  if (rest.every(([t]) => t === 'b')) {
    const shade = (i) => ((i & 7) + (i >> 3)) % 2
    return rest.every(([, i]) => shade(i) === shade(rest[0][1]))
  }
  return false
}

// What counts for repetition: pieces, side to move, castling rights and a real en-passant chance
export function positionKey (p) {
  let ep = '-'
  if (p.ep >= 0 && legalMoves(p).some(m => m.flag === 'ep')) ep = sqName(p.ep)
  return p.b.map(x => x || '.').join('') + p.turn + (p.castle || '-') + ep
}

// The game is over by the rules: { result: '1-0' | '0-1' | '1/2-1/2', reason } or null
export function outcome (p, keys = []) {
  const legal = legalMoves(p)
  if (!legal.length) {
    return inCheck(p)
      ? { result: p.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' }
      : { result: '1/2-1/2', reason: 'stalemate' }
  }
  if (insufficient(p.b)) return { result: '1/2-1/2', reason: 'insufficient' }
  if (p.half >= 100) return { result: '1/2-1/2', reason: 'fifty' }
  if (keys.length) {
    const last = keys[keys.length - 1]
    if (keys.filter(k => k === last).length >= 3) return { result: '1/2-1/2', reason: 'repetition' }
  }
  return null
}

// Count leaf positions (for testing the move generator against known numbers)
export function perft (p, depth) {
  if (depth === 0) return 1
  const moves = legalMoves(p)
  if (depth === 1) return moves.length
  let n = 0
  for (const m of moves) n += perft(play(p, m), depth - 1)
  return n
}

// Pieces each side has lost, for the "captured" row next to the board
const FULL = { p: 8, n: 2, b: 2, r: 2, q: 1 }
export function capturedPieces (p) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } }
  for (const pc of p.b) if (pc && pc.toLowerCase() !== 'k') count[colorOf(pc)][pc.toLowerCase()]++
  const lost = { w: [], b: [] }
  for (const c of ['w', 'b']) {
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      // a promoted pawn can push a count above the starting number
      for (let i = count[c][t]; i < FULL[t]; i++) lost[c].push(c === 'w' ? t.toUpperCase() : t)
    }
  }
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9 }
  let score = 0
  for (const pc of p.b) if (pc && pc.toLowerCase() !== 'k') score += (colorOf(pc) === 'w' ? 1 : -1) * val[pc.toLowerCase()]
  return { lost, score } // score > 0: white is ahead in material
}
