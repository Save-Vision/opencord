// No-limit Texas hold'em at a table in the chat, dealt by mental poker (see main/poker.js):
// nobody's app ever knows a card it isn't allowed to see, so a modified app can't peek.
//
//  msg { game: { kind: 'poker', chips, sb, bb, timer, seats } }   opens a table; the message is its card
//  poker.sit    { id }                 take a seat with `chips` chips
//  poker.leave  { id }                 get up (folds a hand you're in when it's your turn)
//  poker.away   { id, on }             sit out the next hands / come back
//  poker.rebuy  { id }                 broke: buy in again
//  poker.start  { id, on }             the host starts (or pauses) dealing
//  poker.end    { id }                 the host closes the table
//  poker.deal   { id, h, players }     hand h with these players (in seat order)
//  poker.shuf   { id, h, deck }        shuffle step of the next player (52 locked cards)
//  poker.lock   { id, h, deck, commits } lock step of the next player
//  poker.keys   { id, h, k: { idx: key } } keys that open cards for others (or for everyone)
//  poker.act    { id, h, n, a, to }    action n of the hand: fold | check | call | raise (to = total bet)
//  poker.time   { id, h, n }           the player to act at action n ran out of time
//  poker.void   { id, h }              a step stalled (someone left mid-hand): the hand is undone
//
// Every app replays these the same way: an op counts the first time (in signing order) it's
// valid. Cards come from opening locked cards with published keys, which the app does
// asynchronously; until a card is open, the hand waits.

const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)
const order = (x, y) => x.t - y.t || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.s - y.s)

export const RANKS = '23456789TJQKA'
export const SUITS = ['♣', '♦', '♥', '♠']
export const cardRank = (c) => c >> 2
export const cardSuit = (c) => c & 3
export const cardLabel = (c) => (c >> 2 === 8 ? '10' : RANKS[c >> 2]) + SUITS[c & 3]

export const CHIP_OPTIONS = [500, 1000, 2000, 5000]
export const STALL_MS = 60000 // a shuffle, lock or key that doesn't come for this long undoes the hand
export const TIMEOUT_NO_TIMER = 45000 // without a timer, someone who's gone is folded after this
const CLOCK_SLACK = 3000
export const BLIND_OPTIONS = [[5, 10], [10, 20], [25, 50], [50, 100]]
export const TIMER_OPTIONS = [0, 20, 30, 60, 120]

export function cleanPokerInfo (d) {
  if (!d || typeof d !== 'object' || d.kind !== 'poker') return null
  const chips = CHIP_OPTIONS.includes(d.chips) ? d.chips : 1000
  const bb = Number.isInteger(d.bb) && d.bb >= 2 && d.bb <= chips / 10 ? d.bb : 20
  return {
    kind: 'poker',
    chips,
    bb,
    sb: Number.isInteger(d.sb) && d.sb >= 1 && d.sb < bb ? d.sb : Math.floor(bb / 2),
    timer: TIMER_OPTIONS.includes(d.timer) ? d.timer : 30,
    seats: Number.isInteger(d.seats) && d.seats >= 2 && d.seats <= 8 ? d.seats : 6
  }
}

// ---------------------------------------------------------------- hand ranking

const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush']

// 5 cards -> a number: higher is better
function score5 (cs) {
  const ranks = cs.map(cardRank).sort((a, b) => b - a)
  const flush = cs.every(c => cardSuit(c) === cardSuit(cs[0]))
  const uniq = [...new Set(ranks)]
  let straightHigh = -1
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0]
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[4] === 0) straightHigh = 3 // A-2-3-4-5
  }
  const counts = new Map()
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1)
  // ranks by (count, rank), e.g. full house KKK22 -> [K, 2]
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const shape = groups.map(x => x[1]).join('')
  let cat
  let tie
  if (straightHigh >= 0 && flush) { cat = 8; tie = [straightHigh] } else if (shape === '41') { cat = 7; tie = groups.map(x => x[0]) } else if (shape === '32') { cat = 6; tie = groups.map(x => x[0]) } else if (flush) { cat = 5; tie = ranks } else if (straightHigh >= 0) { cat = 4; tie = [straightHigh] } else if (shape === '311') { cat = 3; tie = groups.map(x => x[0]) } else if (shape === '221') { cat = 2; tie = groups.map(x => x[0]) } else if (shape === '2111') { cat = 1; tie = groups.map(x => x[0]) } else { cat = 0; tie = ranks }
  let v = cat
  for (let i = 0; i < 5; i++) v = v * 13 + (tie[i] ?? 0)
  return v
}

// The best 5 of 5–7 cards: { score, cat, name, cards }
export function bestHand (cards) {
  let best = null
  const n = cards.length
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const s = score5(chosen)
      if (!best || s > best.score) best = { score: s, cards: chosen.slice() }
      return
    }
    for (let i = start; i <= n - (5 - chosen.length); i++) { chosen.push(cards[i]); pick(i + 1, chosen); chosen.pop() }
  }
  pick(0, [])
  best.cat = Math.floor(best.score / 13 ** 5)
  best.name = handName(best)
  return best
}

const RANK_NAME = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace']
const plural = (r) => r === 4 ? 'sixes' : RANK_NAME[r] + 's'
function handName (b) {
  const digits = []
  let v = b.score
  for (let i = 0; i < 5; i++) { digits.unshift(v % 13); v = Math.floor(v / 13) }
  const [a, c] = digits
  switch (b.cat) {
    case 8: return a === 12 ? 'Royal flush' : `Straight flush, ${RANK_NAME[a]} high`
    case 7: return `Four ${plural(a)}`
    case 6: return `Full house, ${plural(a)} full of ${plural(c)}`
    case 5: return `Flush, ${RANK_NAME[a]} high`
    case 4: return `Straight, ${RANK_NAME[a]} high`
    case 3: return `Three ${plural(a)}`
    case 2: return `Two pair, ${plural(a)} and ${plural(c)}`
    case 1: return `Pair of ${plural(a)}`
    default: return `${RANK_NAME[a][0].toUpperCase() + RANK_NAME[a].slice(1)} high`
  }
}
export { CATEGORY }

// ---------------------------------------------------------------- replaying a table

// Which deck positions hold what, for n players: hole cards 2i, 2i+1; board after them
export const holeIdx = (n, i) => [2 * i, 2 * i + 1]
export const boardIdx = (n) => [2 * n, 2 * n + 1, 2 * n + 2, 2 * n + 3, 2 * n + 4]
const STREET_CARDS = [[], [0, 1, 2], [3], [4]] // board cards that come with each street
export const STREETS = ['Pre-flop', 'Flop', 'Turn', 'River']

// game: { info, by, ops: [{ k, a, s, t, recv, h, n, deck, commits, keys, act, to, on }] }
// pub(h, idx): the card at that deck position, opened with published keys only (undefined while
// not open yet, -1 if the published keys don't open it)
export function derivePoker (game, pub = () => undefined) {
  const { info, by } = game
  const st = {
    kind: 'poker',
    info,
    by,
    seats: [], // { key, stack, away, left, buyins }
    started: false,
    closed: false,
    hands: 0, // hands dealt so far
    hand: null, // the current (or last) hand
    status: 'open' // 'open' | 'playing' | 'over' | 'missing'
  }
  if (!info) { st.status = 'missing'; return st }
  const seat = (k) => st.seats.find(s => s.key === k && !s.left)
  const inHand = () => st.hand && st.hand.stage !== 'done' && st.hand.stage !== 'void'

  // ---- one hand ----
  const finish = (hand, stage) => {
    hand.stage = stage
    hand.toAct = null
    for (const p of hand.players) {
      const s = st.seats.find(x => x.key === p)
      if (s) s.stack = hand.stack[p]
    }
  }
  const voidHand = (hand, why) => {
    for (const p of hand.players) hand.stack[p] += hand.contrib[p]
    hand.result = { void: true, why }
    finish(hand, 'void')
  }
  const active = (hand) => hand.players.filter(p => !hand.folded.has(p))
  const canAct = (hand) => active(hand).filter(p => !hand.allin.has(p))
  const nextFrom = (hand, i, ok) => {
    for (let j = 1; j <= hand.n; j++) {
      const p = hand.players[(i + j) % hand.n]
      if (ok(p)) return p
    }
    return null
  }
  const needsToAct = (hand, p) => !hand.folded.has(p) && !hand.allin.has(p) && (!hand.acted.has(p) || hand.bets[p] < hand.bet)
  const put = (hand, p, amount) => {
    const x = Math.min(amount, hand.stack[p])
    hand.stack[p] -= x
    hand.bets[p] += x
    hand.contrib[p] += x
    if (hand.stack[p] === 0) hand.allin.add(p)
    return x
  }

  const startStreet = (hand, street, since) => {
    hand.street = street
    hand.bet = 0
    hand.minRaise = info.bb
    hand.acted = new Set()
    for (const p of hand.players) hand.bets[p] = 0
    hand.stage = 'bet'
    // first to act: after the button (heads-up post-flop: the big blind, who isn't the button)
    hand.toAct = nextFrom(hand, hand.b, p => needsToAct(hand, p))
    hand.since = since
    hand.turnT = curT
    if (!hand.toAct || canAct(hand).length <= 1 && canAct(hand).every(p => hand.bets[p] >= hand.bet)) endStreet(hand, since)
  }

  const endStreet = (hand, since) => {
    hand.toAct = null
    if (active(hand).length === 1) return settle(hand)
    if (hand.street === 3) { hand.stage = 'showdown'; hand.since = since; hand.turnT = curT; return advance(hand, since) }
    hand.stage = 'deal'
    hand.street++
    hand.since = since
    hand.turnT = curT
    advance(hand, since)
  }

  // Waiting on cards: a street's board cards, or the hole cards shown at the showdown
  const advance = (hand, since) => {
    if (hand.stage === 'deal') {
      const want = STREET_CARDS[hand.street].map(i => hand.boardAt[i])
      const got = want.map(j => pub(hand.h, j))
      if (got.some(c => c === -1)) return voidHand(hand, 'badkey')
      if (got.some(c => c == null)) return
      STREET_CARDS[hand.street].forEach((i, x) => { hand.board[i] = got[x] })
      hand.log.push({ e: 'board', street: hand.street, cards: got })
      // nobody left to bet (everyone else is all-in): deal on
      const street = hand.street
      if (canAct(hand).length <= 1) {
        if (street === 3) { hand.stage = 'showdown'; return advance(hand, since) }
        hand.stage = 'deal'
        hand.street = street + 1
        return advance(hand, since)
      }
      return startStreet(hand, street, since)
    }
    if (hand.stage === 'showdown') {
      for (const p of active(hand)) {
        const i = hand.players.indexOf(p)
        const cs = holeIdx(hand.n, i).map(j => pub(hand.h, j))
        if (cs.some(c => c === -1)) return voidHand(hand, 'badkey')
        if (cs.some(c => c == null)) return
        hand.shown[p] = cs
      }
      return settle(hand)
    }
  }

  // Pots, layer by layer: everyone who put in at least that much and is still in can win it
  const settle = (hand) => {
    const live = active(hand)
    const won = {}
    for (const p of hand.players) won[p] = 0
    const ranking = {}
    if (live.length === 1) {
      won[live[0]] = hand.players.reduce((sum, p) => sum + hand.contrib[p], 0)
    } else {
      for (const p of live) ranking[p] = bestHand([...hand.shown[p], ...hand.board])
      const levels = [...new Set(hand.players.map(p => hand.contrib[p]).filter(x => x > 0))].sort((a, b) => a - b)
      let prev = 0
      let carry = 0
      for (const lv of levels) {
        let amount = carry
        for (const p of hand.players) amount += Math.min(hand.contrib[p], lv) - Math.min(hand.contrib[p], prev)
        prev = lv
        const eligible = live.filter(p => hand.contrib[p] >= lv)
        if (!eligible.length) { carry = amount; continue }
        carry = 0
        const top = Math.max(...eligible.map(p => ranking[p].score))
        // winners in seat order from the left of the button, who get the odd chips first
        const winners = []
        for (let j = 1; j <= hand.n; j++) {
          const p = hand.players[(hand.b + j) % hand.n]
          if (eligible.includes(p) && ranking[p].score === top) winners.push(p)
        }
        const share = Math.floor(amount / winners.length)
        let odd = amount - share * winners.length
        for (const p of winners) { won[p] += share + (odd > 0 ? 1 : 0); odd-- }
      }
      if (carry) won[live[0]] += carry
    }
    for (const p of hand.players) hand.stack[p] += won[p]
    hand.result = {
      won,
      ranking: Object.fromEntries(Object.entries(ranking).map(([p, r]) => [p, { name: r.name, cards: r.cards, score: r.score }])),
      winners: hand.players.filter(p => won[p] > hand.contrib[p] || (won[p] > 0 && live.length === 1))
    }
    finish(hand, 'done')
  }

  const act = (hand, p, a, to, since) => {
    const need = hand.bet - hand.bets[p]
    const before = hand.bet
    if (a === 'fold') {
      hand.folded.add(p)
    } else if (a === 'check') {
      if (need > 0) return false
    } else if (a === 'call') {
      if (need <= 0) return false
      put(hand, p, need)
    } else if (a === 'raise') {
      if (!Number.isInteger(to) || to <= hand.bet) return false
      const max = hand.bets[p] + hand.stack[p]
      if (to > max) return false
      const full = to - hand.bet >= hand.minRaise
      if (!full && to !== max) return false // less than a min raise only as an all-in
      if (hand.acted.has(p) && !hand.reopened.has(p)) return false // a short all-in doesn't reopen the betting
      put(hand, p, to - hand.bets[p])
      if (full) {
        hand.minRaise = to - hand.bet
        hand.acted = new Set()
        hand.reopened = new Set(hand.players)
      }
      hand.bet = to
    } else return false
    hand.acted.add(p)
    hand.reopened.delete(p)
    hand.acts++
    hand.log.push({ e: 'act', p, a, to: a === 'raise' ? to : a === 'call' ? hand.bets[p] : undefined, allin: hand.allin.has(p), street: hand.street, raised: before > 0 })
    const next = nextFrom(hand, hand.players.indexOf(p), q => needsToAct(hand, q))
    if (active(hand).length === 1 || !next) { endStreet(hand, since); return true }
    hand.toAct = next
    hand.since = since
    hand.turnT = curT
    // someone who left the table folds when it's their turn
    if (seatLeft(next)) return act(hand, next, hand.bets[next] >= hand.bet ? 'check' : 'fold', 0, since)
    return true
  }
  const seatLeft = (p) => !seat(p)

  const deal = (o) => {
    const players = o.players
    const n = players.length
    // button: the next player after the last hand's button
    const last = st.hand
    let b = 0
    if (last) {
      const li = st.seats.findIndex(s => s.key === last.players[last.b])
      for (let j = 1; j <= st.seats.length; j++) {
        const k = st.seats[(li + j) % st.seats.length]?.key
        if (players.includes(k)) { b = players.indexOf(k); break }
      }
    }
    const hand = {
      h: o.h,
      players,
      n,
      b,
      stage: 'shuffle',
      step: 0,
      deck: null,
      commits: {},
      keys: new Map(), // deck position -> Map(player -> key)
      boardAt: boardIdx(n),
      board: [null, null, null, null, null],
      shown: {},
      stack: {},
      bets: {},
      contrib: {},
      folded: new Set(),
      allin: new Set(),
      acted: new Set(),
      reopened: new Set(players),
      bet: 0,
      minRaise: info.bb,
      street: 0,
      acts: 0,
      toAct: null,
      since: o.recv,
      turnT: o.t, // signed time the current step began (checked by 'time' and 'void')
      log: [],
      result: null
    }
    for (const p of players) {
      hand.stack[p] = seat(p).stack
      hand.bets[p] = 0
      hand.contrib[p] = 0
    }
    // blinds (heads-up: the button posts the small blind)
    const sbI = n === 2 ? b : (b + 1) % n
    const bbI = (sbI + 1) % n
    hand.sbP = players[sbI]
    hand.bbP = players[bbI]
    put(hand, hand.sbP, info.sb)
    put(hand, hand.bbP, info.bb)
    hand.bet = info.bb
    hand.bbIndex = bbI
    st.hand = hand
    st.hands = o.h
  }

  // ---- apply ops: each one the first time it's valid, in signing order ----
  let curT = 0
  const apply = (o) => {
    curT = o.t
    const me = seat(o.a)
    switch (o.k) {
      case 'sit':
        if (st.closed || me || st.seats.filter(s => !s.left).length >= info.seats) return false
        if (inHand() && st.hand.players.includes(o.a)) return false // still in a hand from before they got up
        st.seats = st.seats.filter(s => s.key !== o.a)
        st.seats.push({ key: o.a, stack: info.chips, away: false, left: false, buyins: 1 })
        return true
      case 'leave':
        if (!me) return false
        me.left = true
        if (inHand() && st.hand.stage === 'bet' && st.hand.toAct === o.a) act(st.hand, o.a, st.hand.bets[o.a] >= st.hand.bet ? 'check' : 'fold', 0, o.recv)
        return true
      case 'away':
        if (!me) return false
        me.away = !!o.on
        return true
      case 'rebuy':
        if (!me || me.stack > 0 || (inHand() && st.hand.players.includes(o.a))) return false
        me.stack = info.chips
        me.buyins++
        return true
      case 'start':
        if (o.a !== by || st.closed) return false
        st.started = o.on !== false
        return true
      case 'end':
        if (o.a !== by || st.closed) return false
        st.closed = true
        return true
      case 'deal': {
        if (!st.started || st.closed || inHand() || o.h !== st.hands + 1 || !me) return false
        const ps = Array.isArray(o.players) ? o.players : []
        if (ps.length < 2 || ps.length > 8 || new Set(ps).size !== ps.length) return false
        // in seat order, all seated with chips
        const idx = ps.map(p => st.seats.findIndex(s => s.key === p && !s.left && !s.away && s.stack > 0))
        if (idx.some(i => i < 0) || idx.some((v, i) => i && v <= idx[i - 1])) return false
        deal(o)
        return true
      }
    }
    const hand = st.hand
    if (!hand || o.h !== hand.h || !hand.players.includes(o.a)) return false
    if (hand.stage === 'done' || hand.stage === 'void') return false
    switch (o.k) {
      case 'shuf':
      case 'lock': {
        if (hand.stage !== (o.k === 'shuf' ? 'shuffle' : 'lock') || hand.players[hand.step] !== o.a) return false
        if (!Array.isArray(o.deck) || o.deck.length !== 52 || new Set(o.deck).size !== 52) return false
        if (o.k === 'lock') {
          if (!Array.isArray(o.commits) || o.commits.length !== 52) return false
          hand.commits[o.a] = o.commits
        }
        hand.deck = o.deck
        hand.step++
        hand.since = o.recv
        hand.turnT = o.t
        if (hand.step === hand.n) {
          hand.step = 0
          if (o.k === 'shuf') hand.stage = 'lock'
          else {
            hand.stage = 'bet'
            hand.street = 0
            // pre-flop: first after the big blind (heads-up: the button)
            hand.toAct = nextFrom(hand, hand.bbIndex, p => needsToAct(hand, p))
            if (!hand.toAct) endStreet(hand, o.recv)
            else if (seatLeft(hand.toAct)) act(hand, hand.toAct, 'fold', 0, o.recv)
          }
        }
        return true
      }
      case 'keys': {
        if (!hand.deck || hand.stage === 'shuffle' || hand.stage === 'lock') return false
        for (const [j, key] of Object.entries(o.keys || {})) {
          const i = Number(j)
          if (!Number.isInteger(i) || i < 0 || i >= 52 || typeof key !== 'string') continue
          let m = hand.keys.get(i)
          if (!m) { m = new Map(); hand.keys.set(i, m) }
          if (!m.has(o.a)) m.set(o.a, key)
        }
        return true
      }
      case 'act':
        if (hand.stage !== 'bet' || hand.toAct !== o.a || o.n !== hand.acts) return false
        return act(hand, o.a, o.act, o.to, o.recv)
      case 'time': {
        if (hand.stage !== 'bet' || o.n !== hand.acts || !hand.toAct || hand.toAct === o.a) return false
        // only after the turn's time is up (by the signed times; a few seconds of clock slack)
        if (o.t - hand.turnT < (info.timer ? info.timer * 1000 : TIMEOUT_NO_TIMER) - CLOCK_SLACK) return false
        const p = hand.toAct
        const at = hand.log.length
        act(hand, p, hand.bets[p] >= hand.bet ? 'check' : 'fold', 0, o.recv)
        if (hand.log[at]) hand.log[at].timeout = true
        return true
      }
      case 'void': {
        // only while the hand waits on someone else's cards for a long time
        const w = waitingOn(st)
        if (!w || w.stage === 'act' || !w.keys.length || w.keys.includes(o.a)) return false
        if (o.t - hand.turnT < STALL_MS - CLOCK_SLACK) return false
        voidHand(hand, 'stalled')
        return true
      }
    }
    return false
  }

  // Table ops (sitting down, leaving, …) count at their place in time, once. Hand ops can wait
  // for the step they belong to (clocks differ a little between PCs), until their hand is over.
  const TABLE = new Set(['sit', 'leave', 'away', 'rebuy', 'start', 'end'])
  const pending = game.ops.slice().sort(order)
  let progress = true
  while (progress) {
    progress = false
    for (let i = 0; i < pending.length; i++) {
      const o = pending[i]
      // waiting for cards can move a hand on without any op
      if (st.hand && (st.hand.stage === 'deal' || st.hand.stage === 'showdown')) advance(st.hand, st.hand.since)
      if (TABLE.has(o.k)) {
        pending.splice(i, 1)
        if (apply(o)) { progress = true; break }
        i--
        continue
      }
      if (st.hand && Number.isInteger(o.h) && o.h < st.hand.h) { pending.splice(i--, 1); continue } // an old hand's leftovers
      if (apply(o)) {
        pending.splice(i, 1)
        progress = true
        break
      }
    }
  }
  if (st.hand && (st.hand.stage === 'deal' || st.hand.stage === 'showdown')) advance(st.hand, st.hand.since)

  st.status = st.closed && !inHand() ? 'over' : st.started ? 'playing' : 'open'
  return st
}

// ---------------------------------------------------------------- helpers for the table UI

// Who the hand is waiting for, and on what
export function waitingOn (st) {
  const hand = st.hand
  if (!hand) return null
  if (hand.stage === 'shuffle' || hand.stage === 'lock') return { stage: hand.stage, keys: [hand.players[hand.step]] }
  if (hand.stage === 'bet') return { stage: 'act', keys: [hand.toAct] }
  if (hand.stage === 'deal') {
    const idx = STREET_CARDS[hand.street].map(i => hand.boardAt[i])
    return { stage: 'deal', keys: hand.players.filter(p => idx.some(j => !hand.keys.get(j)?.has(p))) }
  }
  if (hand.stage === 'showdown') {
    const live = hand.players.filter(p => !hand.folded.has(p))
    return { stage: 'show', keys: live.filter(p => holeIdx(hand.n, hand.players.indexOf(p)).some(j => !hand.keys.get(j)?.has(p))) }
  }
  return null
}

// Deck positions whose keys I still owe right now
export function keysIOwe (st, me) {
  const hand = st.hand
  if (!hand || !hand.players.includes(me) || !hand.deck || ['shuffle', 'lock', 'done', 'void'].includes(hand.stage)) return []
  const out = []
  const mine = hand.players.indexOf(me)
  const have = (j) => hand.keys.get(j)?.has(me)
  // everyone else's hole cards, as soon as the deck is locked
  hand.players.forEach((p, i) => { if (i !== mine) for (const j of holeIdx(hand.n, i)) if (!have(j)) out.push(j) })
  if (hand.stage === 'deal') for (const i of STREET_CARDS[hand.street]) if (!have(hand.boardAt[i])) out.push(hand.boardAt[i])
  if (hand.stage === 'showdown' && !hand.folded.has(me)) for (const j of holeIdx(hand.n, mine)) if (!have(j)) out.push(j)
  return out
}

// Positions that everyone has published keys for (so anyone can open them)
export function openable (hand) {
  const out = []
  if (!hand?.deck) return out
  for (const [j, m] of hand.keys) if (hand.players.every(p => m.has(p))) out.push(j)
  return out
}

// What I may do now: { check, call, minRaise, maxRaise }
export function myOptions (st, me) {
  const hand = st.hand
  if (!hand || hand.stage !== 'bet' || hand.toAct !== me) return null
  const need = hand.bet - hand.bets[me]
  const max = hand.bets[me] + hand.stack[me]
  const canRaise = (!hand.acted.has(me) || hand.reopened.has(me)) && max > hand.bet
  const minTo = Math.min(max, hand.bet + hand.minRaise)
  return {
    check: need <= 0,
    call: need > 0 ? Math.min(need, hand.stack[me]) : 0,
    allinCall: need > 0 && need >= hand.stack[me],
    raise: canRaise,
    minTo,
    maxTo: max,
    pot: hand.players.reduce((s, p) => s + hand.contrib[p], 0),
    bet: hand.bet,
    mine: hand.bets[me]
  }
}

export const potOf = (hand) => hand ? hand.players.reduce((s, p) => s + hand.contrib[p], 0) : 0
