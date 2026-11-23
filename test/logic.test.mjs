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
