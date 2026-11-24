// What every app at a poker table does on its own, so playing is just clicking Fold / Call /
// Raise: shuffle and lock the deck when it's its turn, publish the keys others need (their hole
// cards right away, board cards when they're due, its own hole cards at the showdown), open the
// cards everyone may see, deal the next hand, and fold players whose time ran out.
// The card crypto runs in the main process with keys derived from this identity (main/poker.js).

import { api, model, append } from './core.js'
import { keysIOwe, openable, holeIdx, waitingOn, STALL_MS, TIMEOUT_NO_TIMER } from './poker.js'

const busy = new Set() // jobs in flight
const tried = new Map() // job -> last attempt (retries for ops that may have been too early)
const doneAt = new Map() // table -> { h, at }: when this app saw the hand end
const RESULT_PAUSE = 5000 // look at the result before the next hand

function once (job, fn, retryMs = 0) {
  if (busy.has(job)) return
  const last = tried.get(job)
  if (last && (!retryMs || Date.now() - last < retryMs)) return
  busy.add(job)
  tried.set(job, Date.now())
  Promise.resolve().then(fn).catch((err) => console.warn('[poker]', job, err)).finally(() => busy.delete(job))
}

const online = (g, k) => k === model.me.key || g.online.has(k)

function tableTick (g, gm) {
  const id = gm.id
  const st = model.gameState(g, id)
  if (!st || st.status === 'missing') return
  const me = model.me.key
  const hand = st.hand
  const live = hand && hand.stage !== 'done' && hand.stage !== 'void'

  // ---- cards everyone may see (spectators too) ----
  if (hand?.deck) {
    for (const j of openable(hand)) {
      const k = hand.h + ':' + j
      if (gm.cards.has(k)) continue
      once(`open:${id}:${k}`, async () => {
        const card = await api.pokerOpen(hand.deck[j], hand.players.map(p => hand.keys.get(j).get(p)))
        model.setPokerCard(g, id, hand.h, j, card)
      })
    }
  }

  if (live && hand.players.includes(me)) {
    const h = hand.h
    // ---- my hole cards, for my eyes only ----
    if (hand.deck && hand.stage !== 'shuffle' && hand.stage !== 'lock') {
      const i = hand.players.indexOf(me)
      for (const j of holeIdx(hand.n, i)) {
        if (gm.mine.has(h + ':' + j)) continue
        const others = hand.players.filter(p => p !== me).map(p => hand.keys.get(j)?.get(p))
        if (others.some(x => !x)) continue
        once(`mine:${id}:${h}:${j}`, async () => {
          const card = await api.pokerOpenMine(id, h, j, hand.deck[j], others)
          model.setPokerCard(g, id, h, j, card, true)
        })
      }
    }
    // ---- shuffle / lock ----
    if ((hand.stage === 'shuffle' || hand.stage === 'lock') && hand.players[hand.step] === me) {
      once(`${hand.stage}:${id}:${h}`, async () => {
        if (hand.stage === 'shuffle') {
          const deck = await api.pokerShuffle(id, h, hand.step === 0 ? null : hand.deck)
          await append(g.id, 'poker.shuf', { id, h, deck })
        } else {
          const r = await api.pokerLock(id, h, hand.deck)
          await append(g.id, 'poker.lock', { id, h, deck: r.deck, commits: r.commits })
        }
      })
    }
    // ---- keys I owe ----
    const owe = keysIOwe(st, me)
    if (owe.length) {
      once(`keys:${id}:${h}:${owe.join(',')}`, async () => {
        const k = await api.pokerReveal(id, h, owe)
        await append(g.id, 'poker.keys', { id, h, k })
      }, 15000)
    }
    // ---- someone's time ran out, or they're gone ----
    if (hand.stage === 'bet' && hand.toAct && hand.toAct !== me) {
      const limit = st.info.timer ? st.info.timer * 1000 : online(g, hand.toAct) ? null : TIMEOUT_NO_TIMER
      const order = hand.players.indexOf(me) // not everyone at once
      if (limit != null && Date.now() - hand.since > limit + 1500 + order * 700) {
        once(`time:${id}:${h}:${hand.acts}`, () => append(g.id, 'poker.time', { id, h, n: hand.acts }), 5000)
      }
    }
    // ---- a step that never comes (someone closed the app mid-hand) ----
    const w = waitingOn(st)
    if (w && w.stage !== 'act' && w.keys.length && !w.keys.includes(me) && Date.now() - hand.since > STALL_MS + 2000) {
      once(`void:${id}:${h}`, () => append(g.id, 'poker.void', { id, h }), 10000)
    }
  }

  // ---- deal the next hand ----
  if (st.started && !st.closed && !live) {
    const seats = st.seats.filter(s => !s.left)
    const mine = seats.findIndex(s => s.key === me)
    const players = seats.filter(s => !s.away && s.stack > 0 && online(g, s.key)).map(s => s.key)
    if (mine >= 0 && players.includes(me) && players.length >= 2) {
      const hNext = st.hands + 1
      let seen = doneAt.get(id)
      if (!seen || seen.h !== st.hands) { seen = { h: st.hands, at: Date.now() }; doneAt.set(id, seen) }
      const pause = (hand ? RESULT_PAUSE : 1500) + players.indexOf(me) * 1500
      if (Date.now() - seen.at >= pause) once(`deal:${id}:${hNext}`, () => append(g.id, 'poker.deal', { id, h: hNext, players }), 8000)
    }
  }
}

function tick () {
  if (!model.me?.key) return
  for (const g of model.groups.values()) {
    if (g.kickedMe || g.restoring) continue
    for (const gm of g.games.values()) {
      if (gm.info?.kind !== 'poker') continue
      // tables nobody touched in a day sleep (they wake up with the next op)
      if (Date.now() - Math.max(gm.t, gm.last || 0) > 864e5) continue
      try { tableTick(g, gm) } catch (err) { console.warn('[poker]', err) }
    }
  }
}

export function startPoker () {
  let queued = false
  model.subscribe(() => {
    if (queued) return
    queued = true
    setTimeout(() => { queued = false; tick() }, 50)
  })
  setInterval(tick, 1000)
}
