// Headless tests for the UI's game and channel logic (chess rules, chess games replayed from
// ops, folders, group settings). Run: npm test
import test from 'node:test'
import assert from 'node:assert'

// model.js expects a few browser globals
globalThis.document = { hasFocus: () => true }
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
// the model's housekeeping timers must not keep the test process alive
const realInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms) => { const t = realInterval(fn, ms); t.unref?.(); return t }

const chess = await import('../src/renderer/lib/chess.js')
const { deriveChess, clockLeft, moveLeft } = await import('../src/renderer/lib/games.js')
const { Model } = await import('../src/renderer/lib/model.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

test('chess: move generation matches the known perft counts', () => {
  const cases = [
    [chess.START, [20, 400, 8902]],
    // castling, en passant, promotions, pins (the "Kiwipete" position)
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]]
  ]
  for (const [fen, counts] of cases) {
    const p = chess.fromFen(fen)
    assert.strictEqual(chess.toFen(p), fen)
    counts.forEach((n, i) => assert.strictEqual(chess.perft(p, i + 1), n, `${fen} depth ${i + 1}`))
  }
})

test('chess: notation, mate, stalemate and draws', () => {
  const line = (ucis, fen) => {
    let p = chess.fromFen(fen)
    const out = []
    for (const u of ucis) {
      const m = chess.findMove(p, u)
      assert.ok(m, 'legal: ' + u)
      out.push(chess.san(p, m))
      p = chess.play(p, m)
    }
    return { p, out }
  }
  assert.deepStrictEqual(line(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5c6', 'd7c6', 'e1g1']).out, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O'])
  const mate = line(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'])
  assert.strictEqual(mate.out[6], 'Qxf7#')
  assert.deepStrictEqual(chess.outcome(mate.p), { result: '1-0', reason: 'checkmate' })
  assert.strictEqual(chess.outcome(chess.fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).reason, 'stalemate')
  assert.strictEqual(chess.outcome(chess.fromFen('8/8/8/4k3/8/8/2B5/4K3 w - - 0 1')).reason, 'insufficient')
  assert.strictEqual(chess.outcome(chess.fromFen('8/8/8/4k3/8/8/2R5/4K3 w - - 0 1')), null)
  assert.strictEqual(chess.outcome(chess.fromFen('4k3/8/8/8/8/8/4P3/4K3 w - - 100 80')).reason, 'fifty')
  // disambiguation and promotion
  const knights = chess.fromFen('4k3/8/8/1N3N2/8/1N6/8/4K3 w - - 0 1')
  assert.deepStrictEqual(['b5d4', 'b3d4', 'f5d4'].map(u => chess.san(knights, chess.findMove(knights, u))), ['Nb5d4', 'N3d4', 'Nfd4'])
  const promo = chess.fromFen('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1')
  assert.strictEqual(chess.san(promo, chess.findMove(promo, 'e7e8q')), 'e8=Q')
  assert.strictEqual(chess.findMove(promo, 'e7e8'), null, 'a promotion needs a piece')
  // repetition: knights out and back twice
  let p = chess.fromFen()
  const keys = [chess.positionKey(p)]
  for (const u of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) { p = chess.play(p, chess.findMove(p, u)); keys.push(chess.positionKey(p)) }
  assert.strictEqual(chess.outcome(p, keys).reason, 'repetition')
})

// ---- games from ops

let seq = { [A]: 0, [B]: 0, [C]: 0 }
const op = (k, a, d = {}, t = Date.now()) => ({ k, a, s: ++seq[a], t, n: Number.isInteger(d.n) ? d.n : -1, m: d.m || '', left: Number.isFinite(d.left) ? d.left : null, no: !!d.no, recv: t })
const game = (info, ops, by = A) => deriveChess({ info: { kind: 'chess', side: 'w', opp: null, tc: null, ...info }, by, ops })
const moves = (list, white = A, black = B, t0 = 1000) => list.map((m, i) => op('move', i % 2 ? black : white, { n: i + 1, m }, t0 + i))

test('chess games: seats, legal moves only, and the first move signed for a ply wins', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  // nobody joined yet: moves don't count
  let st = game({}, [op('move', A, { n: 1, m: 'e2e4' })])
  assert.strictEqual(st.status, 'open')
  // a challenge only the named opponent can accept
  st = game({ opp: B }, [op('join', C, {}, 1), op('move', A, { n: 1, m: 'e2e4' })])
  assert.strictEqual(st.status, 'open')
  st = game({ opp: B }, [op('join', B, {}, 1)])
  assert.strictEqual(st.status, 'active')
  assert.strictEqual(st.white, A)
  assert.strictEqual(st.black, B)
  // an open game: the earliest join takes the seat; the creator can't join their own game
  st = game({ side: 'b' }, [op('join', A, {}, 1), op('join', C, {}, 3), op('join', B, {}, 2)])
  assert.strictEqual(st.white, B)
  assert.strictEqual(st.black, A)

  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const ops = [op('join', B, {}, 1)]
  ops.push(op('move', B, { n: 1, m: 'e2e4' }, 2)) // not white
  ops.push(op('move', A, { n: 1, m: 'e2e5' }, 3)) // illegal
  ops.push(op('move', A, { n: 1, m: 'd2d4' }, 4)) // white's first legal move: counts
  ops.push(op('move', A, { n: 1, m: 'e2e4' }, 1)) // signed later (higher seq), even if its clock says earlier
  ops.push(op('move', C, { n: 2, m: 'd7d5' }, 5)) // a spectator
  ops.push(op('move', B, { n: 2, m: 'g8f6' }, 6))
  st = game({}, ops)
  assert.deepStrictEqual(st.plies.map(p => p.san), ['d4', 'Nf6'])
  assert.strictEqual(st.pos.turn, 'w')
  // the same ops in any order give the same game
  const shuffled = deriveChess({ info: { kind: 'chess', side: 'w', opp: null, tc: null }, by: A, ops: [...ops].reverse() })
  assert.deepStrictEqual(shuffled.plies.map(p => p.san), ['d4', 'Nf6'])
})

test('chess games: mate, resign, draw offers, cancel, decline and time', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const join = op('join', B, {}, 1)
  // fool's mate: black wins
  let st = game({}, [join, ...moves(['f2f3', 'e7e5', 'g2g4', 'd8h4'])])
  assert.strictEqual(st.status, 'over')
  assert.deepStrictEqual([st.result, st.reason], ['0-1', 'checkmate'])
  assert.strictEqual(st.plies[3].san, 'Qh4#')
  // moves after the end don't count
  st = game({}, [join, ...moves(['f2f3', 'e7e5', 'g2g4', 'd8h4', 'a2a3'])])
  assert.strictEqual(st.plies.length, 4)

  const opening = moves(['e2e4', 'e7e5'])
  // white resigns after two plies; black's later move is ignored
  st = game({}, [join, ...opening, op('resign', A, { n: 2 }), op('move', A, { n: 3, m: 'g1f3' })])
  assert.deepStrictEqual([st.result, st.reason], ['0-1', 'resign'])
  // a spectator can't resign for anyone
  st = game({}, [join, ...opening, op('resign', C, { n: 2 })])
  assert.strictEqual(st.status, 'active')
  // draw: offered, then accepted at the same ply
  st = game({}, [join, ...opening, op('draw', A, { n: 2 }, 10)])
  assert.strictEqual(st.drawOffer, A)
  st = game({}, [join, ...opening, op('draw', A, { n: 2 }, 10), op('draw', B, { n: 2 }, 11)])
  assert.deepStrictEqual([st.result, st.reason], ['1/2-1/2', 'agreement'])
  // declined, or the game moved on: no draw
  st = game({}, [join, ...opening, op('draw', A, { n: 2 }, 10), op('draw', B, { n: 2, no: true }, 11), op('draw', B, { n: 2 }, 12)])
  assert.strictEqual(st.status, 'active')
  assert.strictEqual(st.drawOffer, B)
  st = game({}, [join, ...opening, op('draw', A, { n: 1 }, 10), op('draw', B, { n: 2 }, 11)])
  assert.strictEqual(st.status, 'active')
  // cancel: only before both players moved
  st = game({}, [join, ...moves(['e2e4']), op('abort', B, { n: 1 })])
  assert.deepStrictEqual([st.status, st.reason], ['over', 'aborted'])
  st = game({}, [join, ...opening, op('abort', B, { n: 2 })])
  assert.strictEqual(st.status, 'active')
  // the creator cancels an open game; the challenged person declines
  assert.strictEqual(game({}, [op('abort', A, {}, 1)]).reason, 'aborted')
  assert.strictEqual(game({ opp: B }, [op('decline', B, {}, 1)]).reason, 'declined')
  assert.strictEqual(game({ opp: B }, [op('decline', C, {}, 1)]).status, 'open')
  // flag: only with a clock, and only after both players moved
  assert.strictEqual(game({}, [join, ...opening, op('flag', B, { n: 2 })]).status, 'active')
  const tc = { base: 60000, inc: 2000 }
  st = game({ tc }, [join, ...opening, op('flag', B, { n: 2 })])
  assert.deepStrictEqual([st.result, st.reason], ['0-1', 'time'])
})

test('chess games: clocks run on the mover\'s own time', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const tc = { base: 60000, inc: 2000 }
  const ops = [op('join', B, {}, 0)]
  ops.push({ ...op('move', A, { n: 1, m: 'e2e4', left: 60000 }), recv: 1000 })
  ops.push({ ...op('move', B, { n: 2, m: 'e7e5', left: 60000 }), recv: 2000 })
  let st = game({ tc }, ops)
  assert.strictEqual(st.clock.running, 'w')
  assert.strictEqual(clockLeft(st, 'w', 12000), 50000) // 10 s since black's move arrived here
  assert.strictEqual(clockLeft(st, 'b', 12000), 60000)
  assert.strictEqual(moveLeft(st, 'w', 12000), 52000) // plus the increment
  ops.push({ ...op('move', A, { n: 3, m: 'g1f3', left: 52000 }), recv: 12000 })
  st = game({ tc }, ops)
  assert.strictEqual(st.clock.w, 52000)
  assert.strictEqual(st.clock.running, 'b')
  // no clock: nothing runs
  assert.strictEqual(game({}, ops).clock, null)
})

// ---- folders and settings through the model

function makeModel (me = A) {
  const model = new Model()
  model.me = { key: me, name: 'me' }
  model.settings = {}
  model.addGroup({ id: 'g1', nameHint: 'G', joinedAt: 0, membership: { owner: A, admins: [] } })
  return model
}
let n = 0
const raw = (k, a, d, t = ++n) => ({ g: 'g1', k, a, s: ++seq[a], t, d })

test('folders: nesting, moving channels, deleting a folder, and loops from moves made at once', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const ops = [
    raw('channel.create', A, { id: 'gen', name: 'general', kind: 'text' }),
    raw('channel.create', A, { id: 'talk', name: 'Talk', kind: 'voice' }),
    raw('folder.create', A, { id: 'F', name: 'Gaming', parent: null }),
    raw('folder.create', B, { id: 'S', name: 'Minecraft', parent: 'F' }),
    raw('channel.create', B, { id: 'mc', name: 'mc', kind: 'text', folder: 'S' }),
    raw('channel.create', B, { id: 'mcv', name: 'MC voice', kind: 'voice', folder: 'S' }),
    raw('channel.move', A, { id: 'talk', folder: 'F', order: 1 })
  ]
  const m1 = makeModel()
  m1.applyOps('g1', ops)
  const g = m1.groups.get('g1')
  let tree = m1.channelTree(g)
  assert.deepStrictEqual(tree.text.map(c => c.id), ['gen'])
  assert.deepStrictEqual(tree.voice.map(c => c.id), [])
  assert.deepStrictEqual(tree.folders.map(x => x.f.id), ['F'])
  const F = tree.folders[0]
  assert.deepStrictEqual(F.items.map(i => i.ch ? i.ch.id : i.node.f.id), ['talk', 'S'])
  assert.deepStrictEqual(F.items[1].node.items.map(i => i.ch.id), ['mc', 'mcv'])
  assert.deepStrictEqual(m1.orderedChannels(g, 'text').map(c => c.id), ['gen', 'mc'])

  // any order of arrival gives the same tree
  const m2 = makeModel(B)
  m2.applyOps('g1', [...ops].reverse())
  const flat = (t) => JSON.stringify([t.text.map(c => c.id), t.voice.map(c => c.id), t.folders.map(function walk (x) { return [x.f.id, x.items.map(i => i.ch ? i.ch.id : walk(i.node))] })])
  assert.strictEqual(flat(m2.channelTree(m2.groups.get('g1'))), flat(tree))

  // deleting "Gaming": what was in it moves up a level, nothing is lost
  m1.applyOps('g1', [raw('folder.delete', C, { id: 'F' })])
  tree = m1.channelTree(g)
  assert.deepStrictEqual(tree.voice.map(c => c.id), ['talk'])
  assert.deepStrictEqual(tree.folders.map(x => x.f.id), ['S'])

  // two people move folders into each other at the same time: both end up at the top
  const m3 = makeModel()
  m3.applyOps('g1', [
    raw('folder.create', A, { id: 'X', name: 'X' }),
    raw('folder.create', A, { id: 'Y', name: 'Y' }),
    raw('folder.set', A, { id: 'X', parent: 'Y' }, 100),
    raw('folder.set', B, { id: 'Y', parent: 'X' }, 100)
  ])
  assert.deepStrictEqual(m3.channelTree(m3.groups.get('g1')).folders.map(x => x.f.id).sort(), ['X', 'Y'])

  // too deep: a 4th level goes to the top
  const m4 = makeModel()
  m4.applyOps('g1', [
    raw('folder.create', A, { id: 'L1', name: '1' }),
    raw('folder.create', A, { id: 'L2', name: '2', parent: 'L1' }),
    raw('folder.create', A, { id: 'L3', name: '3', parent: 'L2' }),
    raw('folder.create', A, { id: 'L4', name: '4', parent: 'L3' })
  ])
  const g4 = m4.groups.get('g1')
  assert.deepStrictEqual(m4.channelTree(g4).folders.map(x => x.f.id).sort(), ['L1', 'L4'])
  assert.strictEqual(m4.folderDepth(g4, g4.folders.get('L3')), 2)
})

test('group settings: each setting keeps its own newest value, only admins count', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const m = makeModel()
  const g = m.groups.get('g1')
  m.applyOps('g1', [raw('group.settings', A, { invites: 'admins' }, 10)])
  m.applyOps('g1', [raw('group.settings', A, { claude: 'off' }, 20)])
  assert.deepStrictEqual(m.groupSettings(g), { invites: 'admins', claude: 'off' })
  m.applyOps('g1', [raw('group.settings', B, { claude: 'on', invites: 'all' }, 30)]) // not an admin
  assert.deepStrictEqual(m.groupSettings(g), { invites: 'admins', claude: 'off' })
  assert.deepStrictEqual(m.settingsWith(g, { claude: 'on' }), { invites: 'admins', claude: 'on' })
  assert.strictEqual(m.claudeAllowed(g), false)
})

test('messages: Claude answers and chess cards are recognised', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const m = makeModel(B)
  const g = m.groups.get('g1')
  m.applyOps('g1', [
    raw('channel.create', A, { id: 'gen', name: 'general', kind: 'text' }),
    raw('msg', A, { id: 'q', ch: 'gen', text: '@claude what is 2+2?' }),
    raw('msg', A, { id: 'ans', ch: 'gen', text: '4', re: 'q', bot: { n: 'claude', model: 'claude-opus-5-5' } }),
    raw('msg', A, { id: 'gm', ch: 'gen', text: 'chess', game: { kind: 'chess', side: 'w', opp: B, tc: null } }),
    raw('msg', A, { id: 'odd', ch: 'gen', text: 'x', bot: { n: 'someone-else' }, game: { kind: 'checkers' } })
  ])
  assert.deepStrictEqual(g.msgById.get('ans').bot, { model: 'claude-opus-5-5' })
  assert.strictEqual(g.msgById.get('odd').bot, null)
  assert.strictEqual(g.msgById.get('odd').game, false)
  assert.strictEqual(g.msgById.get('gm').game, true)
  const st = m.gameState(g, 'gm')
  assert.strictEqual(st.status, 'open')
  assert.ok(m.isMyTurn(st), 'a challenge to me waits for me')
  assert.strictEqual(m.unread(g, 'gen').mentions, 1)
  // a live draft disappears when the real answer arrives
  m.setClaudeDraft('g1', A, { id: 'next', ch: 'gen', text: 'Thinking' })
  assert.strictEqual(m.claudeDraftsIn(g, 'gen').length, 1)
  m.applyOps('g1', [raw('msg', A, { id: 'next', ch: 'gen', text: 'done', bot: { n: 'claude' } })])
  assert.strictEqual(m.claudeDraftsIn(g, 'gen').length, 0)
})

// ---------------------------------------------------------------- 0.6

const poker = await import('../src/renderer/lib/poker.js')
const { makeTable } = await import('./pokersim.mjs')
const { transcript, claudeMayRead } = await import('../src/renderer/lib/claudelog.js')
const { parseQuery, searchMessages } = await import('../src/renderer/lib/search.js')

const card = (s) => {
  const r = poker.RANKS.indexOf(s[0] === '1' ? 'T' : s[0])
  const suit = { c: 0, d: 1, h: 2, s: 3 }[s[s.length - 1]]
  return r * 4 + suit
}
const hand = (str) => str.split(' ').map(card)

test('poker: hand ranking', () => {
  const name = (s) => poker.bestHand(hand(s)).name
  assert.strictEqual(name('As Ks Qs Js Ts 2d 3c'), 'Royal flush')
  assert.strictEqual(name('5h 4h 3h 2h Ah Kd Kc'), 'Straight flush, five high')
  assert.strictEqual(name('9c 9d 9h 9s 2c 3d 4h'), 'Four nines')
  assert.strictEqual(name('Kc Kd Kh 2s 2c 7d 8h'), 'Full house, kings full of twos')
  assert.strictEqual(name('Ah 9h 7h 4h 2h Kd Kc'), 'Flush, ace high')
  assert.strictEqual(name('Ad 2c 3h 4s 5d Kd Kc'), 'Straight, five high')
  assert.strictEqual(name('6d 6c 6h As Kd 2c 3h'), 'Three sixes')
  assert.strictEqual(name('Jd Jc 4h 4s Ad 2c 3h'), 'Two pair, jacks and fours')
  assert.strictEqual(name('Qd Qc 4h 8s Ad 2c 3h'), 'Pair of queens')
  assert.strictEqual(name('Ad Jc 4h 8s 9d 2c 3h'), 'Ace high')
  const s = (x) => poker.bestHand(hand(x)).score
  assert.ok(s('As Ad Kc Qd 2h') > s('As Ad Kc Jd 2h'), 'kickers count')
  assert.ok(s('6s 5d 4c 3d 2h') > s('As 2d 3c 4d 5h'), 'the wheel is the lowest straight')
  assert.strictEqual(s('As Ad Kc Qd 2h'), s('Ah Ac Ks Qh 2d'), 'suits never break ties')
})

test('poker: three players play hands with real card crypto, chips add up', () => {
  const T = makeTable(['alice', 'bob', 'carol'])
  const [a, b, c] = T.players
  for (const p of T.players) T.post(p, 'sit')
  T.post(b, 'start', { on: true }) // not the host: ignored
  T.post(a, 'deal', { h: 1, players: T.players.map(p => p.key) })
  let st = T.auto()
  assert.strictEqual(st.hand, null, 'no dealing before the host starts')
  T.post(a, 'start', { on: true })
  T.post(a, 'deal', { h: 1, players: T.players.map(p => p.key) })
  st = T.auto()
  assert.strictEqual(st.hand.stage, 'bet')
  // everyone sees their own two cards, and they're all different
  const holes = T.players.map(p => T.myCards(p))
  const all = holes.flat()
  assert.ok(all.every(x => x >= 0 && x < 52))
  assert.strictEqual(new Set(all).size, 6)
  // nobody else's hole cards were opened with published keys
  for (const [i] of T.players.entries()) for (const j of poker.holeIdx(3, i)) assert.strictEqual(T.cards.get('1:' + j), undefined)
  // blinds: button alice, small blind bob, big blind carol; alice acts first
  assert.strictEqual(st.hand.toAct, a.key)
  assert.strictEqual(st.hand.bets[b.key], 10)
  assert.strictEqual(st.hand.bets[c.key], 20)
  // an action out of turn doesn't count
  T.post(c, 'act', { h: 1, n: st.hand.acts, act: 'fold' })
  st = T.auto()
  assert.ok(!st.hand.folded.has(c.key))
  st = T.act(a, 'raise', 60)
  st = T.act(b, 'fold')
  st = T.act(c, 'call')
  assert.strictEqual(st.hand.street, 1)
  assert.strictEqual(st.hand.board.slice(0, 3).filter(x => x != null).length, 3)
  // check it down
  while (st.hand.stage === 'bet') st = T.act(T.players.find(p => p.key === st.hand.toAct), 'check')
  assert.strictEqual(st.hand.stage, 'done')
  const board = st.hand.board
  assert.strictEqual(new Set([...board, ...holes[0], ...holes[2]]).size, 9)
  // the showdown opened exactly the hands still in, and they match what their owners saw
  assert.deepStrictEqual(st.hand.shown[a.key], holes[0])
  assert.deepStrictEqual(st.hand.shown[c.key], holes[2])
  assert.strictEqual(st.hand.shown[b.key], undefined, 'folded cards stay hidden')
  const total = st.seats.reduce((x, s) => x + s.stack, 0)
  assert.strictEqual(total, 3000)
  const best = (p) => poker.bestHand([...st.hand.shown[p.key], ...board]).score
  if (best(a) !== best(c)) assert.ok(st.hand.result.winners.includes(best(a) > best(c) ? a.key : c.key))
  // a second deal for the same hand number is ignored, the next one rotates the button
  T.post(b, 'deal', { h: 3, players: T.players.map(p => p.key) })
  T.post(b, 'deal', { h: 2, players: T.players.map(p => p.key) })
  st = T.auto()
  assert.strictEqual(st.hand.h, 2)
  assert.strictEqual(st.hand.players[st.hand.b], b.key)
})

test('poker: all-in side pots, short all-ins and min raises', () => {
  const T = makeTable(['alice', 'bob', 'carol'])
  const [a, b, c] = T.players
  for (const p of T.players) T.post(p, 'sit')
  T.post(a, 'start', { on: true })
  T.post(a, 'deal', { h: 1, players: T.players.map(p => p.key) })
  let st = T.auto()
  // a raise below the minimum isn't allowed (unless it's all-in)
  T.post(a, 'act', { h: 1, n: 0, act: 'raise', to: 30 })
  st = T.auto()
  assert.strictEqual(st.hand.acts, 0)
  st = T.act(a, 'raise', 1000) // all-in
  assert.ok(st.hand.allin.has(a.key))
  st = T.act(b, 'call')
  st = T.act(c, 'fold')
  // both all-in: the board is dealt out without betting
  assert.strictEqual(st.hand.stage, 'done')
  assert.ok(st.hand.board.every(x => x != null))
  const total = st.seats.reduce((x, s) => x + s.stack, 0)
  assert.strictEqual(total, 3000)
  const won = st.hand.result.won
  assert.strictEqual(won[a.key] + won[b.key] + won[c.key], 2020)

  // stacks of different sizes: the short stack can only win what it matched
  const st2 = poker.derivePoker({
    info: poker.cleanPokerInfo({ kind: 'poker', chips: 1000, sb: 10, bb: 20 }),
    by: A,
    ops: []
  })
  assert.strictEqual(st2.status, 'open')
})

test('poker: timeouts and stalled hands need their time, by the signed clocks', () => {
  const T = makeTable(['alice', 'bob'], { timer: 30 })
  const [a, b] = T.players
  T.post(a, 'sit')
  T.post(b, 'sit')
  T.post(a, 'start', { on: true })
  T.post(a, 'deal', { h: 1, players: [a.key, b.key] })
  let st = T.auto()
  // heads-up: the button (alice) is the small blind and acts first pre-flop
  assert.strictEqual(st.hand.sbP, a.key)
  assert.strictEqual(st.hand.toAct, a.key)
  const t0 = st.hand.turnT
  // too early: ignored
  T.game.ops.push({ k: 'time', a: b.key, s: ++b.s, t: t0 + 5000, recv: t0 + 5000, h: 1, n: st.hand.acts })
  st = T.derive()
  assert.strictEqual(st.hand.acts, 0)
  T.game.ops.push({ k: 'time', a: b.key, s: ++b.s, t: t0 + 31000, recv: t0 + 31000, h: 1, n: st.hand.acts })
  st = T.auto()
  assert.strictEqual(st.hand.stage, 'done', 'alice folded on time')
  assert.strictEqual(st.hand.log.find(e => e.e === 'act').timeout, true)
  // a stalled shuffle can be voided only after a minute, and only by someone who isn't the one stalling
  T.post(b, 'deal', { h: 2, players: [a.key, b.key] })
  st = T.derive()
  assert.strictEqual(st.hand.stage, 'shuffle')
  const shuffler = st.hand.players[0] === a.key ? a : b
  const other = shuffler === a ? b : a
  const t1 = st.hand.turnT
  T.game.ops.push({ k: 'void', a: shuffler.key, s: ++shuffler.s, t: t1 + 70000, recv: t1 + 70000, h: 2 })
  T.game.ops.push({ k: 'void', a: other.key, s: ++other.s, t: t1 + 10000, recv: t1 + 10000, h: 2 })
  st = T.derive()
  assert.strictEqual(st.hand.stage, 'shuffle')
  const before = st.seats.map(s => s.stack)
  T.game.ops.push({ k: 'void', a: other.key, s: ++other.s, t: t1 + 61000, recv: t1 + 61000, h: 2 })
  st = T.derive()
  assert.strictEqual(st.hand.stage, 'void')
  assert.deepStrictEqual(st.seats.map(s => s.stack), before, 'blinds go back')
})

test('poker: a wrong card key cancels the hand instead of dealing garbage', () => {
  const T = makeTable(['alice', 'bob'])
  const [a, b] = T.players
  T.post(a, 'sit')
  T.post(b, 'sit')
  T.post(a, 'start', { on: true })
  T.post(a, 'deal', { h: 1, players: [a.key, b.key] })
  let st = T.auto()
  st = T.act(a, 'call')
  // bob publishes a bogus key for the first flop card before the honest app does
  const j = st.hand.boardAt[0]
  T.post(b, 'keys', { h: 1, keys: { [j]: 'ab'.repeat(32) } })
  st = T.act(b, 'check')
  assert.strictEqual(st.hand.stage, 'void')
  assert.strictEqual(st.hand.result.why, 'badkey')
})

test('polls: one vote each (the newest), multi-choice, closing and end times', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const m = makeModel(B)
  const g = m.groups.get('g1')
  m.applyOps('g1', [
    raw('channel.create', A, { id: 'gen', name: 'general', kind: 'text' }),
    raw('msg', A, { id: 'p1', ch: 'gen', text: '📊 Pizza?', poll: { q: 'Pizza?', opts: [{ id: '1', t: 'Yes' }, { id: '2', t: 'No' }, { id: '2', t: 'dupe' }] } }),
    raw('msg', A, { id: 'bad', ch: 'gen', text: 'x', poll: { q: 'One option', opts: [{ id: '1', t: 'only' }] } })
  ])
  const p = g.msgById.get('p1')
  assert.strictEqual(p.poll.opts.length, 2)
  assert.strictEqual(g.msgById.get('bad').poll, null)
  m.applyOps('g1', [
    raw('poll.vote', B, { id: 'p1', v: ['1'] }, 100),
    raw('poll.vote', C, { id: 'p1', v: ['1', '2'] }, 101), // single choice: only the first counts
    raw('poll.vote', B, { id: 'p1', v: ['2'] }, 102) // changed mind
  ])
  let r = m.pollResults(g, p)
  assert.deepStrictEqual(r.voters.get('1'), [C])
  assert.deepStrictEqual(r.voters.get('2'), [B])
  assert.deepStrictEqual(r.mine, ['2'])
  assert.strictEqual(r.total, 2)
  // only the author can close it; votes after that don't count
  m.applyOps('g1', [raw('poll.close', B, { id: 'p1' }, 103), raw('poll.vote', A, { id: 'p1', v: ['1'] }, 104)])
  r = m.pollResults(g, p)
  assert.strictEqual(r.total, 3)
  m.applyOps('g1', [raw('poll.close', A, { id: 'p1' }, 105), raw('poll.vote', C, { id: 'p1', v: ['2'] }, 106)])
  r = m.pollResults(g, p)
  assert.ok(r.ended && r.closed)
  assert.deepStrictEqual(r.voters.get('1'), [C, A])
})

test('Claude only reads the asker, its answers to them, and people who allowed it', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const m = makeModel(A)
  const g = m.groups.get('g1')
  m.memberName = (g, k) => ({ [A]: 'Ann', [B]: 'Ben', [C]: 'Cat' })[k]
  m.applyOps('g1', [
    raw('channel.create', A, { id: 'gen', name: 'general', kind: 'text' }),
    raw('profile', C, { name: 'Cat', color: '#2dd4bf', claude: true }),
    raw('msg', B, { id: 'm1', ch: 'gen', text: 'my secret plans' }),
    raw('msg', C, { id: 'm2', ch: 'gen', text: 'cat is fine with Claude' }),
    raw('msg', A, { id: 'm3', ch: 'gen', text: '@claude summarize' }),
    raw('msg', A, { id: 'm4', ch: 'gen', text: 'A summary', re: 'm3', bot: { n: 'claude', model: 'claude-opus-5-5' } }),
    raw('msg', B, { id: 'm5', ch: 'gen', text: 'ben replies to claude', re: 'm4' }),
    raw('msg', A, { id: 'm6', ch: 'gen', text: 'what about this?', re: 'm1' })
  ])
  assert.ok(!claudeMayRead(m, g, g.msgById.get('m1')))
  assert.ok(claudeMayRead(m, g, g.msgById.get('m2')))
  let log = transcript(m, g, g.msgById.get('m3'))
  assert.ok(!log.text.includes('secret'), 'other people are left out')
  assert.ok(log.text.includes('cat is fine with Claude'))
  assert.ok(log.text.includes('summarize'))
  assert.strictEqual(log.skipped, 1)
  // replying to a message shows Claude that one message, on purpose
  log = transcript(m, g, g.msgById.get('m6'))
  assert.ok(log.text.includes('my secret plans'))
  assert.ok(log.text.includes('A summary'))
  assert.ok(!log.text.includes('ben replies'))
  // Ben asks by replying to Claude: Ann's messages and Claude's answers to her stay out
  const mb = makeModel(B)
  const gb = mb.groups.get('g1')
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  mb.applyOps('g1', [
    raw('channel.create', A, { id: 'gen', name: 'general', kind: 'text' }),
    raw('msg', A, { id: 'x1', ch: 'gen', text: 'ann private' }),
    raw('msg', A, { id: 'x2', ch: 'gen', text: 'answer for ann', re: 'x1', bot: { n: 'claude' } }),
    raw('msg', B, { id: 'x3', ch: 'gen', text: 'ben asks', re: 'x2' })
  ])
  log = transcript(mb, gb, gb.msgById.get('x3'))
  assert.ok(log.text.includes('answer for ann'), 'the message replied to')
  assert.ok(!log.text.includes('ann private'), 'but not the chain behind someone else\'s message')
})

test('search: words, people, channels and filters', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const m = makeModel(A)
  const g = m.groups.get('g1')
  m.memberName = (g, k) => ({ [A]: 'Ann', [B]: 'Bén', [C]: 'Cat' })[k]
  m.applyOps('g1', [
    raw('channel.create', A, { id: 'gen', name: 'general', kind: 'text' }),
    raw('channel.create', A, { id: 'mc', name: 'minecraft', kind: 'text' }),
    raw('msg', B, { id: 's1', ch: 'gen', text: 'Café tonight?' }, Date.parse('2026-03-01')),
    raw('msg', A, { id: 's2', ch: 'mc', text: 'new world at https://example.com' }, Date.parse('2026-03-02')),
    raw('msg', C, { id: 's3', ch: 'mc', text: 'pic', att: [{ h: 'f'.repeat(64), s: 10, n: 'base.png', m: 'image/png' }] }, Date.parse('2026-03-03'))
  ])
  const ids = (q) => searchMessages(m, g, q).map(x => x.id)
  assert.deepStrictEqual(ids('cafe'), ['s1'])
  assert.deepStrictEqual(ids('from:ben'), ['s1'])
  assert.deepStrictEqual(ids('from:me'), ['s2'])
  assert.deepStrictEqual(ids('in:#mine'), ['s3', 's2'])
  assert.deepStrictEqual(ids('has:link'), ['s2'])
  assert.deepStrictEqual(ids('has:image base'), ['s3'])
  assert.deepStrictEqual(ids('after:2026-03-01 before:2026-03-03'), ['s2'])
  assert.deepStrictEqual(ids(''), [])
  assert.deepStrictEqual(parseQuery('from:"Ann B" hello').from, ['ann b'])
})

test('status and soundboard: what friends announce, who may remove a sound', () => {
  seq = { [A]: 0, [B]: 0, [C]: 0 }
  const m = makeModel(A)
  const g = m.groups.get('g1')
  m.settings = { status: 'online', autoAway: 10 }
  m.peerJoin('g1', B, { key: B })
  assert.strictEqual(m.presence(g, B), 'online')
  m.setStatus(B, 'away')
  assert.strictEqual(m.presence(g, B), 'away')
  m.setStatus(B, 'invisible')
  assert.strictEqual(m.presence(g, B), 'offline')
  m.peerLeave('g1', B)
  m.peerJoin('g1', B, { key: B })
  assert.strictEqual(m.presence(g, B), 'online', 'a reconnect starts fresh')
  assert.strictEqual(m.presence(g, C), 'offline')
  m.idle = true
  assert.strictEqual(m.myStatus(), 'away')
  m.settings.status = 'invisible'
  assert.strictEqual(m.presence(g, A), 'offline')

  const h = 'e'.repeat(64)
  m.applyOps('g1', [
    raw('sound.add', B, { id: 's1', name: 'Airhorn', emoji: '📯', h, s: 5000, m: 'audio/mpeg', dur: 2000 }),
    raw('sound.add', B, { id: 's2', name: 'Too big', h, s: 5 * 1024 * 1024, m: 'audio/mpeg', dur: 2000 }),
    raw('sound.add', C, { id: 's3', name: 'Boing', h, s: 5000, m: 'audio/ogg', dur: 900 }),
    raw('sound.delete', C, { id: 's1' }) // not theirs, not an admin
  ])
  assert.deepStrictEqual(m.soundsOf(g).map(s => s.id), ['s1', 's3'])
  m.applyOps('g1', [raw('sound.delete', A, { id: 's3' })]) // the owner may
  assert.deepStrictEqual(m.soundsOf(g).map(s => s.id), ['s1'])
})

// ---- 0.6.1: floating panels and themes ----
const layout = await import('../src/renderer/lib/layout.js')
const themes = await import('../src/renderer/lib/themes.js')

test('layout: broken or missing layouts fall back to the default order', () => {
  assert.deepStrictEqual(layout.normalizeLayout(null), { order: ['rail', 'nav', 'main', 'side'], w: {} })
  assert.deepStrictEqual(layout.normalizeLayout({ order: ['main', 'rail'] }).order, layout.DEFAULT_ORDER)
  assert.deepStrictEqual(layout.normalizeLayout({ order: ['rail', 'rail', 'main', 'side'] }).order, layout.DEFAULT_ORDER)
  assert.deepStrictEqual(layout.normalizeLayout({ order: ['side', 'main', 'nav', 'rail'] }).order, ['side', 'main', 'nav', 'rail'])
  // widths are clamped, junk and unknown blocks are dropped
  assert.deepStrictEqual(layout.normalizeLayout({ w: { nav: 9999, side: 'x', main: 500, rail: 10 } }).w, { nav: 420 })
  assert.deepStrictEqual(layout.normalizeLayout({ w: { nav: 10, side: 301.6 } }).w, { nav: 200, side: 302 })
})

test('layout: moving a block to the left or right of another', () => {
  const o = layout.DEFAULT_ORDER
  assert.deepStrictEqual(layout.moveBlock(o, 'side', 'nav', 'before'), ['rail', 'side', 'nav', 'main'])
  assert.deepStrictEqual(layout.moveBlock(o, 'rail', 'side', 'after'), ['nav', 'main', 'side', 'rail'])
  assert.deepStrictEqual(layout.moveBlock(o, 'main', 'rail', 'before'), ['main', 'rail', 'nav', 'side'])
  // dropping next to where it already is changes nothing
  assert.ok(layout.sameOrder(layout.moveBlock(o, 'nav', 'main', 'before'), o))
  assert.ok(layout.sameOrder(layout.moveBlock(o, 'nav', 'nav', 'after'), o))
  assert.ok(layout.sameOrder(layout.moveBlock(o, 'nav', 'nope', 'after'), o))
  // the input is never changed
  assert.deepStrictEqual(o, ['rail', 'nav', 'main', 'side'])
})

test('layout: drop side and resize edge', () => {
  const rect = { left: 100, width: 200 }
  assert.strictEqual(layout.dropSide(rect, 150), 'before')
  assert.strictEqual(layout.dropSide(rect, 250), 'after')
  assert.strictEqual(layout.resizeEdge(layout.DEFAULT_ORDER, 'nav'), 'right')
  assert.strictEqual(layout.resizeEdge(layout.DEFAULT_ORDER, 'side'), 'left')
  assert.strictEqual(layout.resizeEdge(['side', 'main', 'nav', 'rail'], 'side'), 'right')
  assert.strictEqual(layout.resizeEdge(['side', 'main', 'nav', 'rail'], 'nav'), 'left')
})

test('layout: widths snap to the nearby sizes and stay within limits', () => {
  assert.strictEqual(layout.snapWidth('nav', 255), 248)
  assert.strictEqual(layout.snapWidth('nav', 300), 300) // between snaps: stays
  assert.strictEqual(layout.snapWidth('nav', 1000), 420)
  assert.strictEqual(layout.snapWidth('nav', 50), 200)
  assert.strictEqual(layout.snapWidth('side', 412), 420)
  assert.strictEqual(layout.snapWidth('main', 777), 777) // not resizable
  // dragging the right edge to the right widens; a left edge widens when dragged left
  assert.strictEqual(layout.dragWidth(layout.DEFAULT_ORDER, 'nav', 248, 500, 532), 280)
  assert.strictEqual(layout.dragWidth(layout.DEFAULT_ORDER, 'side', 240, 900, 840), 300)
  assert.strictEqual(layout.dragWidth(['side', 'rail', 'nav', 'main'], 'side', 240, 300, 360), 300)
})

test('themes: five themes, unknown ones become Standard, and the page gets the theme', () => {
  assert.deepStrictEqual(themes.THEME_IDS, ['standard', 'minimal', 'xp', 'glass', 'oled'])
  assert.strictEqual(themes.normalizeTheme('glass'), 'glass')
  assert.strictEqual(themes.normalizeTheme('dracula'), 'standard')
  assert.strictEqual(themes.normalizeTheme(undefined), 'standard')
  for (const t of themes.THEMES) assert.ok(t.name && t.hint && t.icons && ['light', 'dark'].includes(t.mode), t.id)
  assert.strictEqual(new Set(themes.THEMES.map(t => t.icons)).size, 5, 'each theme draws its own icons')
  const doc = { documentElement: { dataset: {} } }
  assert.strictEqual(themes.applyTheme({ theme: 'oled' }, doc, true), 'oled')
  assert.deepStrictEqual(doc.documentElement.dataset, { theme: 'oled', mode: 'dark', anim: 'on' })
  themes.applyTheme({ theme: 'nope', animatedBg: false }, doc, true)
  assert.deepStrictEqual(doc.documentElement.dataset, { theme: 'standard', mode: 'dark', anim: 'off' })
})

test('themes: every theme has a light and a dark mode; "system" follows the OS', () => {
  // no choice: the theme's own mode
  assert.strictEqual(themes.resolveMode({ theme: 'xp' }), 'light')
  assert.strictEqual(themes.resolveMode({ theme: 'oled' }), 'dark')
  assert.strictEqual(themes.resolveMode({ theme: 'minimal', mode: null }), 'light')
  // a choice wins for every theme
  for (const id of themes.THEME_IDS) {
    assert.strictEqual(themes.resolveMode({ theme: id, mode: 'light' }), 'light')
    assert.strictEqual(themes.resolveMode({ theme: id, mode: 'dark' }), 'dark')
    assert.strictEqual(themes.resolveMode({ theme: id, mode: 'system' }, true), 'dark')
    assert.strictEqual(themes.resolveMode({ theme: id, mode: 'system' }, false), 'light')
  }
  assert.strictEqual(themes.resolveMode({ theme: 'glass', mode: 'sepia' }), 'light') // junk: theme's own
})

test('themes.css: every theme defines its colours in both modes', async () => {
  const fs = await import('fs')
  const css = fs.readFileSync(new URL('../src/renderer/themes.css', import.meta.url), 'utf8')
  for (const id of themes.THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const m = new RegExp(`html\\[data-theme=${id}\\]\\[data-mode=${mode}\\] \\{([^}]*)\\}`).exec(css)
      assert.ok(m, `${id} ${mode} block`)
      // the theme's shared block can set the panels for both modes (XP points them at its own colours)
      const both = (new RegExp(`html\\[data-theme=${id}\\] \\{([^}]*)\\}`).exec(css)?.[1] || '') + m[1]
      // standard dark keeps styles.css's base colours and only sets the panels
      const need = id === 'standard' && mode === 'dark' ? ['--app-bg', '--main-bg'] : ['--bg-0', '--text-0', '--accent', '--app-bg', '--main-bg']
      for (const v of need) assert.ok(both.includes(v + ':'), `${id} ${mode} sets ${v}`)
    }
  }
  // light modes stay easy on the eyes: no pure white surfaces, no pure black text
  for (const block of css.match(/\[data-mode=light\] \{[^}]*\}/g)) {
    assert.ok(!/--(bg-[0-4]|main-bg|app-bg): #fff(fff)?;/i.test(block), 'no pure white surfaces: ' + block.slice(0, 60))
    assert.ok(!/--text-0: #000(000)?;/i.test(block), 'no pure black text')
  }
  // OLED is no longer pink
  assert.ok(!/ff2bd6/i.test(css), 'OLED accent changed')
  // Minimal: no borders, no shadows
  const minimal = /html\[data-theme=minimal\] \{([^}]*)\}/.exec(css)[1]
  assert.match(minimal, /--panel-border: 0;/)
  assert.match(minimal, /--panel-shadow: none;/)
})

// ---- 0.6.2: shared focus documents ----
const crdt = await import('../src/renderer/lib/textcrdt.js')

// Applies ops to a fresh document in the given order
const replay = (ops) => { const d = new crdt.TextDoc(); for (const [a, data] of ops) d.applyOp(a, data); return d }
const shuffle = (arr, seed) => {
  const a = [...arr]
  let x = seed
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

test('focus docs: typing, deleting and replacing make the right ops', () => {
  const d = new crdt.TextDoc()
  const e1 = d.localReplace('hello world', A)
  assert.strictEqual(d.text(), 'hello world')
  assert.deepStrictEqual(e1.x, [])
  assert.deepStrictEqual(e1.r, [[1, 0, '', 'hello world']])
  const e2 = d.localReplace('hello brave world', A) // typed in the middle
  assert.deepStrictEqual(e2.r, [[12, 6, A, 'brave ']])
  const e3 = d.localReplace('hello world', A) // and deleted again
  assert.deepStrictEqual(e3.x, [[12, A, 6]])
  assert.strictEqual(d.text(), 'hello world')
  assert.strictEqual(d.localReplace('hello world', A), null)
  // someone else replaying our ops gets the same text
  assert.strictEqual(replay([[A, e1], [A, e2], [A, e3]]).text(), 'hello world')
})

test('focus docs: two people typing at once end up with the same text, in any order', () => {
  const base = new crdt.TextDoc()
  const e0 = base.localReplace('The plan:\n', A)
  // Alice and Bob both start from the same text and type at the same time
  const alice = replay([[A, e0]])
  const bob = replay([[A, e0]])
  const ea = alice.localReplace('The plan:\n- pizza\n', A)
  const eb = bob.localReplace('The plan:\n- games\n', B)
  const ea2 = alice.localReplace('Our plan:\n- pizza\n', A)
  const eb2 = bob.localReplace('The plan:\n- games all night\n', B)
  const ops = [[A, e0], [A, ea], [B, eb], [A, ea2], [B, eb2]]
  const want = replay(ops).text()
  assert.ok(want.includes('- pizza\n') && want.includes('- games all night\n') && want.startsWith('Our plan:'), want)
  // each author's ops in their order, interleaved in every possible way
  const aOps = [[A, ea], [A, ea2]]
  const bOps = [[B, eb], [B, eb2]]
  for (let mask = 0; mask < 16; mask++) {
    const merged = [[A, e0]]
    let i = 0
    let j = 0
    for (let k = 0; k < 4; k++) {
      if (j >= 2 || (i < 2 && (mask >> k) & 1)) merged.push(aOps[i++])
      else merged.push(bOps[j++])
    }
    assert.strictEqual(replay(merged).text(), want, 'mask ' + mask)
  }
  // and fully out of order too: an insert waits for the text it was typed after
  for (let seed = 1; seed < 40; seed++) assert.strictEqual(replay(shuffle(ops, seed)).text(), want, 'shuffled ' + seed)
})

test('focus docs: the same spot at the same time is ordered the same everywhere', () => {
  const ea = new crdt.TextDoc().localReplace('AAA', A)
  const eb = new crdt.TextDoc().localReplace('BBB', B)
  const x = replay([[A, ea], [B, eb]]).text()
  assert.strictEqual(x, replay([[B, eb], [A, ea]]).text())
  assert.ok(x === 'AAABBB' || x === 'BBBAAA')
})

test('focus docs: deleting text that has not arrived yet still deletes it', () => {
  const d = new crdt.TextDoc()
  const ins = d.localReplace('secret', A)
  const del = d.localReplace('', A)
  assert.strictEqual(replay([[A, del], [A, ins]]).text(), '')
})

test('focus docs: the caret stays next to the same characters when a friend types', () => {
  const mine = new crdt.TextDoc()
  const e0 = mine.localReplace('hello world', A)
  const theirs = replay([[A, e0]])
  const before = mine.visible().slice()
  const eb = theirs.localReplace('oh, hello world', B) // friend types at the start
  mine.applyOp(B, eb)
  assert.strictEqual(mine.text(), 'oh, hello world')
  assert.strictEqual(crdt.mapCaret(before, mine, 5), 9) // was after "hello", still is
})

test('focus docs: big pastes are split into runs and ops that fit', () => {
  const d = new crdt.TextDoc()
  const big = 'x'.repeat(50000) + '\n' + 'y'.repeat(30000)
  const ed = d.localReplace(big, A)
  assert.ok(ed.r.every(r => r[3].length <= crdt.MAX_RUN))
  const parts = crdt.chunkEdit(ed)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(JSON.stringify({ id: 'x'.repeat(16), ...p }).length < 60000)
  const other = new crdt.TextDoc()
  for (const p of shuffle(parts, 7)) other.applyOp(A, p)
  assert.strictEqual(other.text(), big)
  // junk in ops is ignored
  other.applyOp(B, { r: [['x'], [1, 0, '', 5], null], x: [[1, B, -1], 'no'] })
  assert.strictEqual(other.text(), big)
})

test('focus docs: the model keeps documents, names, and who may delete them', () => {
  const m = new Model()
  m.me = { key: A }
  m.addGroup({ id: 'g1', name: 'Squad', ops: [] })
  const g = m.groups.get('g1')
  let s = 0
  const op = (a, k, d, t) => ({ g: 'g1', a, s: ++s, t, k, d, sig: '' })
  const ed = new crdt.TextDoc().localReplace('# Notes\nhello', A)
  m.applyOps('g1', [op(A, 'group.init', { name: 'Squad' }, 1), op(A, 'doc.set', { id: 'd1', name: 'Notes' }, 2), op(A, 'doc.edit', { id: 'd1', ...ed }, 3), op(B, 'doc.set', { id: 'd1', name: 'Our notes' }, 4)])
  const doc = g.docs.get('d1')
  assert.strictEqual(doc.name, 'Our notes')
  assert.strictEqual(doc.text.text(), '# Notes\nhello')
  assert.strictEqual(doc.createdBy, A)
  assert.deepStrictEqual(m.docsOf(g).map(x => x.id), ['d1'])
  // Bob isn't the creator or an admin: his delete doesn't count
  m.applyOps('g1', [op(B, 'doc.delete', { id: 'd1' }, 5)])
  assert.strictEqual(m.docsOf(g).length, 1)
  m.applyOps('g1', [op(A, 'doc.delete', { id: 'd1' }, 6)])
  assert.strictEqual(m.docsOf(g).length, 0)
  // who has it open comes and goes
  m.setDocPresence('g1', B, { id: 'd1', here: true, line: 3, typing: true })
  assert.deepStrictEqual(m.docPresence('g1', 'd1').map(p => [p.key, p.line, p.typing]), [[B, 3, true]])
  m.setDocPresence('g1', B, { id: 'd1', here: false })
  assert.deepStrictEqual(m.docPresence('g1', 'd1'), [])
})
