// Plays poker hands between simulated apps with the real card crypto. Used by logic.test.mjs.
import { createRequire } from 'module'
import crypto from 'crypto'
import { derivePoker, keysIOwe, openable, holeIdx, myOptions } from '../src/renderer/lib/poker.js'

const require = createRequire(import.meta.url)
const P = require('../src/main/poker.js')

export function makeTable (names, info = {}) {
  const players = names.map((name) => ({ name, key: crypto.createHash('sha256').update(name).digest('hex'), seed: crypto.randomBytes(32), s: 0 }))
  const host = players[0]
  const game = { id: 'tbl', info: { kind: 'poker', chips: 1000, sb: 10, bb: 20, timer: 30, seats: 6, ...info }, by: host.key, ops: [] }
  let clock = 1000
  const cards = new Map() // `${h}:${idx}` -> card, opened with published keys
  const pub = (h, idx) => cards.get(h + ':' + idx)
  const derive = () => derivePoker(game, pub)
  const post = (p, k, d = {}) => {
    clock += 10
    game.ops.push({ k, a: p.key, s: ++p.s, t: clock, recv: clock, ...d })
  }
  // What every honest app does by itself: shuffle, lock, publish keys, open cards
  const auto = () => {
    for (let round = 0; round < 50; round++) {
      let did = false
      const st = derive()
      const hand = st.hand
      if (!hand) return st
      if (hand.stage === 'shuffle' || hand.stage === 'lock') {
        const p = players.find(x => x.key === hand.players[hand.step])
        if (hand.stage === 'shuffle') post(p, 'shuf', { h: hand.h, deck: P.shuffle(p.seed, game.id, hand.h, hand.step === 0 ? null : hand.deck) })
        else { const r = P.lock(p.seed, game.id, hand.h, hand.deck); post(p, 'lock', { h: hand.h, deck: r.deck, commits: r.commits }) }
        did = true
      } else {
        for (const p of players) {
          const owe = keysIOwe(st, p.key)
          if (owe.length) { post(p, 'keys', { h: hand.h, keys: P.reveal(p.seed, game.id, hand.h, owe) }); did = true }
        }
        for (const j of openable(hand)) {
          if (cards.has(hand.h + ':' + j)) continue
          cards.set(hand.h + ':' + j, P.open(hand.deck[j], hand.players.map(k => hand.keys.get(j).get(k))))
          did = true
        }
      }
      if (!did) return derive()
    }
    throw new Error('auto did not settle')
  }
  // My own hole cards, as my app sees them
  const myCards = (p) => {
    const st = derive()
    const hand = st.hand
    const i = hand.players.indexOf(p.key)
    return holeIdx(hand.n, i).map(j => {
      const others = hand.players.filter(k => k !== p.key).map(k => hand.keys.get(j)?.get(k))
      if (others.some(x => !x)) return null
      return P.openMine(p.seed, game.id, hand.h, j, hand.deck[j], others)
    })
  }
  const act = (p, a, to) => {
    const st = derive()
    post(p, 'act', { h: st.hand.h, n: st.hand.acts, act: a, to })
    return auto()
  }
  return { players, game, derive, post, auto, act, myCards, cards, options: (p) => myOptions(derive(), p.key) }
}
