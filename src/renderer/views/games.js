import { html, useState, useEffect, useMemo, useRef } from '../vendor/preact-htm.js'
import { model, act, append, rid, fmtStamp } from '../lib/core.js'
import { DM_TEXT } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { START, fromFen, play, findMove, legalMoves, inCheck, sqName, colorOf, capturedPieces } from '../lib/chess.js'
import { TIME_CONTROLS, tcLabel, clockLeft, moveLeft, winnerOf, REASONS, BOT } from '../lib/games.js'
import { BOT_LEVELS, botLevelName } from '../lib/chessbot.js'
import { Avatar } from './chat.js'
import { Modal } from './modals.js'
import { PokerCard, PokerTable, PokerOptions, pokerStatus, pokerRowInfo } from './poker.js'
import { playTone } from '../lib/sounds.js'

// Filled glyphs for both colours (the CSS paints white pieces white with a dark outline).
// U+FE0E asks for the text form, so no font turns the pawn into an emoji.
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
const glyph = (pc) => GLYPH[pc.toLowerCase()] + '︎'

const nameOf = (g, key) => key ? (key === model.me.key ? 'You' : pName(g, key)) : 'Anyone'
// A player's name: a member, or the computer
const pName = (g, key) => key === BOT ? 'Computer' : model.memberName(g, key)
// What the game is played with: the clock, or the computer's level
const gameKind = (st) => st.info.bot ? 'vs computer · ' + botLevelName(st.info.bot) : tcLabel(st.info.tc)

export function BotAvatar ({ size = 30 }) {
  return html`<div class="avatar bot-avatar" style=${{ width: size + 'px', height: size + 'px' }}><${Icon} name="bot" size=${Math.round(size * 0.6)} /></div>`
}
const sideOf = (st, key) => key && key === st.white ? 'w' : key && key === st.black ? 'b' : null

// "Bob won by checkmate", "Draw by agreement", "White to move"
export function gameStatus (g, st) {
  if (st.status === 'missing') return 'This game is gone'
  if (st.kind === 'poker') return pokerStatus(g, st)
  if (st.status === 'open') {
    if (st.info.opp) return st.info.opp === model.me.key ? `${model.memberName(g, st.by)} challenged you` : `Waiting for ${model.memberName(g, st.info.opp)} to accept`
    return st.by === model.me.key ? 'Waiting for someone to join' : 'Open: anyone can join'
  }
  if (st.status === 'over') {
    if (st.reason === 'aborted') return 'Game cancelled'
    if (st.reason === 'declined') return `${model.memberName(g, st.info.opp)} declined`
    if (st.result === '1/2-1/2') return 'Draw by ' + REASONS[st.reason]
    const w = winnerOf(st)
    return (w === model.me.key ? 'You won' : pName(g, w) + ' won') + ' by ' + REASONS[st.reason]
  }
  const mover = st.pos.turn === 'w' ? st.white : st.black
  if (mover === BOT) return st.by === model.me.key ? 'Computer is thinking…' : 'Computer to move'
  return mover === model.me.key ? 'Your move' : `${model.memberName(g, mover)} to move`
}

const title = (g, st) => `${nameOf(g, st.white)} vs ${nameOf(g, st.black)}`

// ---------------------------------------------------------------- a static mini board

function MiniBoard ({ pos, flipped = false, last = null, size = 120 }) {
  const cells = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col
      const pc = pos.b[sq]
      const dark = ((sq & 7) + (sq >> 3)) % 2 === 0
      const hl = last && (last.from === sq || last.to === sq)
      cells.push(html`<i key=${sq} class="${dark ? 'dk' : 'lt'} ${hl ? 'hl' : ''}">${pc && html`<b class=${colorOf(pc)}>${glyph(pc)}</b>`}</i>`)
    }
  }
  return html`<div class="mini-board" style=${{ width: size + 'px', height: size + 'px', fontSize: Math.round(size / 9.5) + 'px' }}>${cells}</div>`
}

// ---------------------------------------------------------------- the card in the chat

export function GameCard ({ g, m }) {
  const st = model.gameState(g, m.id)
  if (!st || st.status === 'missing') return null
  if (st.kind === 'poker') return html`<${PokerCard} g=${g} m=${m} />`
  const me = model.me.key
  const mine = sideOf(st, me)
  const last = st.plies[st.plies.length - 1]
  const canJoin = st.status === 'open' && st.by !== me && (!st.info.opp || st.info.opp === me) && !g.kickedMe
  const open = () => model.openGame(g.id, m.id)
  const join = async (e) => {
    e.stopPropagation()
    if (await act(() => append(g.id, 'game.join', { id: m.id }))) open()
  }
  const decline = (e) => { e.stopPropagation(); act(() => append(g.id, 'game.decline', { id: m.id })) }
  const free = st.info.side === 'w' ? 'Black' : 'White'
  return html`
    <div class="game-card ${model.isMyTurn(st) ? 'your-turn' : ''}" onClick=${open}>
      <${MiniBoard} pos=${st.pos} flipped=${mine === 'b'} last=${last} size=${112} />
      <div class="gc-info">
        <div class="gc-kind"><${Icon} name=${st.info.bot ? 'bot' : 'chess'} size=${14} /> Chess · ${gameKind(st)}</div>
        <b class="gc-title">${title(g, st)}</b>
        <span class="gc-status ${st.status}">${gameStatus(g, st)}</span>
        ${st.status === 'active' && st.plies.length > 0 && html`<small class="muted">${Math.ceil(st.plies.length / 2)} move${st.plies.length > 2 ? 's' : ''} · last ${last.san}</small>`}
        <div class="gc-actions">
          ${canJoin
            ? html`<button class="btn primary sm" onClick=${join}>${st.info.opp ? 'Accept' : 'Play as ' + free}</button>
                   ${st.info.opp && html`<button class="btn sm" onClick=${decline}>Decline</button>`}`
            : html`<button class="btn sm ${model.isMyTurn(st) ? 'primary' : ''}" onClick=${(e) => { e.stopPropagation(); open() }}>${mine && st.status === 'active' ? 'Open board' : st.status === 'over' ? 'Replay' : mine ? 'Open' : 'Watch'}</button>`}
        </div>
      </div>
    </div>`
}

// ---------------------------------------------------------------- games list

export function GamesView ({ g }) {
  const id = model.ui.games?.id
  if (id && g.games.get(id)?.info?.kind === 'poker') return html`<${PokerTable} key=${id} g=${g} id=${id} />`
  return id ? html`<${GameBoardView} key=${id} g=${g} id=${id} />` : html`<${GamesHub} g=${g} />`
}

function GamesHub ({ g }) {
  const all = model.gamesOf(g)
  const turn = all.filter(x => model.isMyTurn(x.st))
  const playing = all.filter(x => (x.st.status === 'active' || x.st.status === 'playing') && !model.isMyTurn(x.st))
  const open = all.filter(x => x.st.status === 'open' && !model.isMyTurn(x.st))
  const done = all.filter(x => x.st.status === 'over').slice(0, 30)
  const section = (label, list) => list.length > 0 && html`
    <section class="games-section">
      <h3>${label} <small>${list.length}</small></h3>
      <div class="games-grid">${list.map(x => html`<${GameRow} key=${x.id} g=${g} x=${x} />`)}</div>
    </section>`
  return html`
    <section class="games-view">
      <header class="chat-header">
        ${g.dm && html`<button class="icon-btn" title="Back to the chat" onClick=${() => model.selectChannel(g.id, DM_TEXT)}><${Icon} name="chevronLeft" /></button>`}
        <${Icon} name="chess" size=${22} class="dim" /><h2>Games</h2>
        <span class="header-note">Chess moves sync like messages: play live, or one move a day. Poker is live.</span>
        <div class="spacer" />
        <button class="btn primary sm" onClick=${() => model.openModal('newGame', { gid: g.id })}><${Icon} name="plus" size=${15} /> New game</button>
      </header>
      <div class="games-body">
        ${!all.length && html`
          <div class="games-empty">
            <div class="intro-icon"><${Icon} name="chess" size=${36} /></div>
            <h2>No games yet</h2>
            <p>Challenge someone to chess, or open a poker table for the group. Games show up in the chat and everyone can watch.</p>
            <button class="btn primary" onClick=${() => model.openModal('newGame', { gid: g.id })}>Start a game</button>
          </div>`}
        ${section('Your move', turn)}
        ${section('Playing', playing)}
        ${section('Open', open)}
        ${section('Finished', done)}
      </div>
    </section>`
}

function GameRow ({ g, x }) {
  const { st } = x
  const ch = g.channels.get(x.gm.ch)
  if (st.kind === 'poker') {
    return html`
      <button class="game-row poker-row ${model.isMyTurn(st) ? 'your-turn' : ''}" onClick=${() => model.openGame(g.id, x.id)}>
        <div class="gr-poker"><${Icon} name="cards" size=${34} /></div>
        <div class="gr-info">
          <b>${model.memberName(g, st.by)}'s poker table</b>
          <span class="gc-status ${st.status === 'playing' ? 'active' : st.status}">${pokerStatus(g, st)}</span>
          <small class="muted">${pokerRowInfo(g, st)}${!g.dm && ch ? ' · #' + ch.name : ''} · ${fmtStamp(x.last)}</small>
        </div>
      </button>`
  }
  return html`
    <button class="game-row ${model.isMyTurn(st) ? 'your-turn' : ''}" onClick=${() => model.openGame(g.id, x.id)}>
      <${MiniBoard} pos=${st.pos} flipped=${sideOf(st, model.me.key) === 'b'} last=${st.plies[st.plies.length - 1]} size=${84} />
      <div class="gr-info">
        <b>${title(g, st)}</b>
        <span class="gc-status ${st.status}">${gameStatus(g, st)}</span>
        <small class="muted">${gameKind(st)}${!g.dm && ch ? ' · #' + ch.name : ''} · ${fmtStamp(x.last)}</small>
      </div>
    </button>`
}

// ---------------------------------------------------------------- one game

function useTicker (on) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => force(n => n + 1), 250)
    return () => clearInterval(t)
  }, [on])
}

const fmtClock = (ms) => {
  if (ms == null) return ''
  const s = Math.max(0, ms) / 1000
  if (s < 10) return s.toFixed(1)
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(sec).padStart(2, '0') : m + ':' + String(sec).padStart(2, '0')
}

function GameBoardView ({ g, id }) {
  const st = model.gameState(g, id)
  const me = model.me.key
  const mine = st ? sideOf(st, me) : null
  const [flip, setFlip] = useState(false)
  const [view, setView] = useState(null) // ply index shown (null = the current position)
  const running = !!st?.clock?.running
  useTicker(running)
  const flagged = useRef(false)
  const plies = st ? st.plies.length : 0
  useEffect(() => { setView(null) }, [plies])

  // Positions after each ply, for stepping through the game
  const positions = useMemo(() => {
    if (!st) return []
    const out = [fromFen(START)]
    for (const p of st.plies) out.push(play(out[out.length - 1], findMove(out[out.length - 1], p.uci)))
    return out
  }, [st])

  // Out of time on my own clock: say so (an honest app flags itself; the other player can
  // also claim it). Nothing else in the game depends on the clocks.
  const myLeft = st && mine ? clockLeft(st, mine) : null
  useEffect(() => {
    if (!st || flagged.current || st.status !== 'active' || !mine || st.clock?.running !== mine || myLeft > 0) return
    flagged.current = true
    act(() => append(g.id, 'game.flag', { id, n: plies }))
  })

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea')) return
      if (e.key === 'ArrowLeft') setView(v => Math.max(0, (v ?? plies) - 1))
      if (e.key === 'ArrowRight') setView(v => v == null || v + 1 >= plies ? null : v + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [plies])

  if (!st || st.status === 'missing' || !g.msgById.get(id) || g.msgById.get(id).deleted) {
    return html`
      <section class="games-view">
        <header class="chat-header"><button class="icon-btn" onClick=${() => model.openGames(g.id)}><${Icon} name="chevronLeft" /></button><h2>Game</h2></header>
        <div class="games-empty"><p>This game doesn't exist (anymore), or it hasn't synced yet.</p></div>
      </section>`
  }

  const flipped = (mine === 'b') !== flip
  const live = view == null
  const pos = live ? st.pos : positions[view]
  const lastPly = live ? st.plies[plies - 1] : st.plies[view - 1]
  const ch = g.channels.get(g.games.get(id)?.ch)
  const send = (kind, data) => act(() => append(g.id, 'game.' + kind, { id, ...data }))
  const onMove = (mv) => {
    const uci = sqName(mv.from) + sqName(mv.to) + (mv.promo || '')
    send('move', { n: plies + 1, m: uci, left: moveLeft(st, mine) })
  }
  const top = flipped ? 'w' : 'b'
  const bottom = flipped ? 'b' : 'w'
  const { lost, score } = capturedPieces(pos)
  const opp = mine === 'w' ? st.black : st.white
  const oppLeft = st.clock && mine ? clockLeft(st, mine === 'w' ? 'b' : 'w') : null
  const confirm = (titleText, body, label, fn) => model.openModal('confirm', { title: titleText, body, confirm: label, danger: true, onConfirm: fn })
  const rematch = async () => {
    const nid = rid()
    const side = mine === 'w' ? 'b' : 'w'
    const ok = await act(() => append(g.id, 'msg', {
      id: nid,
      ch: g.games.get(id).ch,
      ...(st.info.bot
        ? { text: `♟ ${model.me.name} plays the computer again (${botLevelName(st.info.bot)})`, game: { kind: 'chess', side, opp: model.me.key, bot: st.info.bot } }
        : { text: `♟ ${model.me.name} wants a rematch with @${model.memberName(g, opp)}`, game: { kind: 'chess', side, opp, tc: st.info.tc } })
    }))
    if (ok) model.openGame(g.id, nid)
  }

  const Player = ({ side }) => {
    const key = side === 'w' ? st.white : st.black
    const left = clockLeft(st, side)
    const ahead = side === 'w' ? score : -score
    return html`
      <div class="player-strip ${st.status === 'active' && st.pos.turn === side ? 'to-move' : ''}">
        ${key === BOT
          ? html`<${BotAvatar} size=${30} />`
          : key
          ? html`<${Avatar} name=${model.memberName(g, key)} color=${model.memberColor(g, key)} src=${model.memberAvatar(g, key)} size=${30} dot=${model.presence(g, key)} />`
          : html`<div class="seat-empty"><${Icon} name="userPlus" size=${16} /></div>`}
        <div class="ps-name">
          <b>${key ? pName(g, key) : 'Free seat'}${key === me ? html` <small class="muted">(you)</small>` : key === BOT ? html` <small class="muted">${botLevelName(st.info.bot)}</small>` : ''}</b>
          <span class="captured">${lost[side === 'w' ? 'b' : 'w'].map((pc, i) => html`<i key=${i} class=${colorOf(pc)}>${glyph(pc)}</i>`)}${ahead > 0 ? html`<small>+${ahead}</small>` : ''}</span>
        </div>
        ${st.clock && html`<div class="clock ${st.clock.running === side ? 'running' : ''} ${left != null && left < 20000 ? 'low' : ''}">${fmtClock(left)}</div>`}
      </div>`
  }

  return html`
    <section class="games-view game-view">
      <header class="chat-header">
        <button class="icon-btn" title="All games" onClick=${() => model.openGames(g.id)}><${Icon} name="chevronLeft" /></button>
        <${Icon} name="chess" size=${20} class="dim" />
        <h2>${title(g, st)}</h2>
        <span class="header-note">${gameKind(st)}${!g.dm && ch ? ' · #' + ch.name : ''}</span>
        <div class="spacer" />
        <button class="icon-btn" title="Flip board" onClick=${() => setFlip(!flip)}><${Icon} name="flip" /></button>
      </header>
      <div class="game-body">
        <div class="chess-col">
          <${Player} side=${top} />
          <${Board} pos=${pos} flipped=${flipped} last=${lastPly} onMove=${live && st.status === 'active' && mine && st.pos.turn === mine ? onMove : null} />
          <${Player} side=${bottom} />
        </div>
        <div class="game-side">
          <div class="game-status ${st.status} ${model.isMyTurn(st) ? 'your-turn' : ''}">
            <b>${gameStatus(g, st)}</b>
            ${st.status === 'over' && st.result && html`<span class="result">${{ '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½' }[st.result]}</span>`}
            ${!live && html`<small>Showing move ${Math.ceil(view / 2)}${view % 2 ? '' : '…'} · <a onClick=${() => setView(null)}>back to now</a></small>`}
          </div>

          ${st.status === 'open' && st.by === me && html`
            <div class="game-actions"><button class="btn" onClick=${() => send('abort', { n: 0 })}>Cancel game</button></div>`}
          ${st.status === 'open' && st.by !== me && (!st.info.opp || st.info.opp === me) && html`
            <div class="game-actions">
              <button class="btn primary" onClick=${() => send('join', {})}>${st.info.opp ? 'Accept' : `Play as ${st.info.side === 'w' ? 'Black' : 'White'}`}</button>
              ${st.info.opp && html`<button class="btn" onClick=${() => send('decline', {})}>Decline</button>`}
            </div>`}

          ${st.status === 'active' && mine && st.drawOffer && st.drawOffer !== me && html`
            <div class="draw-offer">
              <span><b>${model.memberName(g, st.drawOffer)}</b> offers a draw</span>
              <button class="btn primary sm" onClick=${() => send('draw', { n: plies })}>Accept</button>
              <button class="btn sm" onClick=${() => send('draw', { n: plies, no: true })}>Decline</button>
            </div>`}
          ${st.status === 'active' && mine && html`
            <div class="game-actions">
              ${plies < 2
                ? html`<button class="btn" onClick=${() => send('abort', { n: plies })}>Cancel game</button>`
                : !st.info.bot && html`<button class="btn" disabled=${st.drawOffer === me} onClick=${() => send('draw', { n: plies })}>${st.drawOffer === me ? 'Draw offered' : 'Offer draw'}</button>`}
              <button class="btn danger-ghost" onClick=${() => confirm('Resign?', `${pName(g, opp)} wins the game.`, 'Resign', () => send('resign', { n: plies }))}><${Icon} name="flag" size=${15} /> Resign</button>
              ${oppLeft != null && oppLeft < -3000 && st.clock.running !== mine && html`
                <button class="btn primary" onClick=${() => send('flag', { n: plies })}>Claim win on time</button>`}
            </div>`}
          ${st.status === 'active' && !mine && html`<p class="muted small">You're watching. Moves appear as they're played.</p>`}
          ${st.status === 'over' && mine && opp && st.reason !== 'aborted' && st.reason !== 'declined' && html`
            <div class="game-actions"><button class="btn primary" onClick=${rematch}>Rematch</button></div>`}

          <${MoveList} st=${st} view=${view} onPick=${setView} />
          <p class="muted small">Chat about the game in its thread →</p>
        </div>
      </div>
    </section>`
}

function MoveList ({ st, view, onPick }) {
  const ref = useRef()
  useEffect(() => { if (view == null && ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [st.plies.length, view])
  const rows = []
  for (let i = 0; i < st.plies.length; i += 2) {
    const cell = (j) => st.plies[j] && html`<button class="mv ${(view == null ? st.plies.length : view) === j + 1 ? 'on' : ''}" onClick=${() => onPick(j + 1 === st.plies.length ? null : j + 1)}>${st.plies[j].san}</button>`
    rows.push(html`<div key=${i} class="mv-row"><span class="mv-n">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</div>`)
  }
  return html`
    <div class="move-list" ref=${ref}>
      ${rows.length ? rows : html`<p class="muted small">No moves yet. White starts.</p>`}
    </div>`
}

// ---------------------------------------------------------------- the board you play on

function Board ({ pos, flipped, last, onMove }) {
  const [sel, setSel] = useState(null)
  const [promo, setPromo] = useState(null) // { from, to } waiting for a piece choice
  const legal = useMemo(() => (onMove ? legalMoves(pos) : []), [pos, !!onMove])
  useEffect(() => { setSel(null); setPromo(null) }, [pos])
  const targets = sel != null ? legal.filter(m => m.from === sel) : []
  const check = inCheck(pos) ? pos.b.indexOf(pos.turn === 'w' ? 'K' : 'k') : -1
  const mineAt = (sq) => onMove && pos.b[sq] && colorOf(pos.b[sq]) === pos.turn

  const go = (from, to) => {
    const ms = legal.filter(m => m.from === from && m.to === to)
    if (!ms.length) return false
    if (ms.length > 1) setPromo({ from, to })
    else { setSel(null); onMove(ms[0]) }
    return true
  }
  const click = (sq) => {
    if (!onMove || promo) return
    if (sel != null && sel !== sq && go(sel, sq)) return
    setSel(mineAt(sq) && sel !== sq ? sq : null)
  }

  const cells = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col
      const pc = pos.b[sq]
      const dark = ((sq & 7) + (sq >> 3)) % 2 === 0
      const target = targets.find(m => m.to === sq)
      const cls = [
        'sq', dark ? 'dk' : 'lt',
        last && (last.from === sq || last.to === sq) ? 'last' : '',
        sel === sq ? 'sel' : '',
        target ? (pc || target.flag === 'ep' ? 'hit' : 'dot') : '',
        sq === check ? 'check' : '',
        mineAt(sq) ? 'can' : ''
      ].join(' ')
      cells.push(html`
        <div key=${sq} class=${cls} data-sq=${sqName(sq)} onClick=${() => click(sq)}
          onDragOver=${(e) => { if (target) e.preventDefault() }}
          onDrop=${(e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/od-sq')); if (Number.isInteger(from)) go(from, sq) }}>
          ${pc && html`<span class="pc ${colorOf(pc)}" draggable=${!!mineAt(sq)}
            onDragStart=${(e) => { setSel(sq); e.dataTransfer.setData('text/od-sq', String(sq)); e.dataTransfer.effectAllowed = 'move' }}>${glyph(pc)}</span>`}
          ${col === 0 && html`<small class="rank">${(sq >> 3) + 1}</small>`}
          ${row === 7 && html`<small class="file">${'abcdefgh'[sq & 7]}</small>`}
        </div>`)
    }
  }
  return html`
    <div class="chess-wrap">
      <div class="chess-board">${cells}</div>
      ${promo && html`
        <div class="promo-pick" onClick=${() => setPromo(null)}>
          <div class="promo-box" onClick=${(e) => e.stopPropagation()}>
            <small>Promote to</small>
            ${'qrbn'.split('').map(t => html`
              <button key=${t} class="pc ${pos.turn}" title=${{ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t]}
                onClick=${() => { const m = legal.find(x => x.from === promo.from && x.to === promo.to && x.promo === t); setPromo(null); setSel(null); if (m) onMove(m) }}>${glyph(t)}</button>`)}
          </div>
        </div>`}
    </div>`
}

// ---------------------------------------------------------------- new game

export function NewGameModal ({ gid, ch: chId = null, opp: presetOpp = null, kind: presetKind = 'chess' }) {
  const g = model.groups.get(gid)
  const texts = g ? model.orderedChannels(g, 'text') : []
  const current = g && model.currentChannel(g)
  const [kind, setKind] = useState(presetKind === 'poker' ? 'poker' : 'chess')
  const [ch, setCh] = useState(g?.dm ? DM_TEXT : chId || current?.id || texts[0]?.id)
  const [opp, setOpp] = useState(g?.dm ? g.dm : presetOpp)
  const [level, setLevel] = useState(2)
  const bot = opp === BOT
  const [side, setSide] = useState('w')
  const [tc, setTc] = useState('none')
  const [poker, setPoker] = useState({ chips: 1000, sb: 10, bb: 20, timer: 30, seats: 6 })
  if (!g) return null
  const others = model.membersOf(g).filter(m => m.key !== model.me.key)
  const openTable = async () => {
    const id = rid()
    const ok = await act(() => append(gid, 'msg', {
      id,
      ch,
      text: `🃏 ${model.me.name} opened a poker table. Take a seat!`,
      game: { kind: 'poker', ...poker }
    }), 'Could not open the table')
    if (!ok) return
    await act(() => append(gid, 'poker.sit', { id }))
    model.closeModal()
    model.openGame(gid, id)
  }
  const start = async () => {
    if (kind === 'poker') return openTable()
    const id = rid()
    const mySide = side === 'r' ? (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 'w' : 'b') : side
    const oppName = opp && !bot ? model.memberName(g, opp) : ''
    const ok = await act(() => append(gid, 'msg', bot
      ? { id, ch, text: `♟ ${model.me.name} is playing chess against the computer (${botLevelName(level)})`, game: { kind: 'chess', side: mySide, opp: model.me.key, bot: level } }
      : {
          id,
          ch,
          text: opp ? `♟ ${model.me.name} challenged @${oppName} to a game of chess` : `♟ ${model.me.name} wants to play chess. Who's in?`,
          game: { kind: 'chess', side: mySide, opp: opp || null, tc: TIME_CONTROLS.find(x => x.id === tc)?.tc || null }
        }), 'Could not start the game')
    if (!ok) return
    model.closeModal()
    model.openGame(gid, id)
  }
  return html`
    <${Modal} title="New game">
      <div class="modal-body new-game">
        <div class="seg-pick two game-kind">
          <button class=${kind === 'chess' ? 'active' : ''} onClick=${() => setKind('chess')}><${Icon} name="chess" size=${18} /> Chess</button>
          <button class=${kind === 'poker' ? 'active' : ''} onClick=${() => setKind('poker')}><${Icon} name="cards" size=${18} /> Poker</button>
        </div>
        ${kind === 'poker' && html`
          ${!g.dm && html`
            <label>Post in
              <select value=${ch} onChange=${(e) => setCh(e.target.value)}>
                ${texts.map(c => html`<option value=${c.id}>#${c.name}</option>`)}
              </select>
            </label>`}
          <${PokerOptions} value=${poker} onChange=${setPoker} />`}
        ${kind === 'chess' && g.dm && html`
          <div class="field-label">Opponent</div>
          <div class="seg-pick two">
            <button class=${!bot ? 'active' : ''} onClick=${() => setOpp(g.dm)}><${Icon} name="users" size=${16} /> ${model.groupName(g)}</button>
            <button class=${bot ? 'active' : ''} onClick=${() => setOpp(BOT)}><${Icon} name="bot" size=${16} /> Computer</button>
          </div>`}
        ${kind === 'chess' && !g.dm && html`
          <label>Opponent
            <select value=${opp || ''} onChange=${(e) => setOpp(e.target.value || null)}>
              <option value="">Anyone in ${model.groupName(g)} (first to join)</option>
              ${others.map(m => html`<option value=${m.key}>${model.memberName(g, m.key)}</option>`)}
              <option value=${BOT}>The computer</option>
            </select>
          </label>
          <label>Post in
            <select value=${ch} onChange=${(e) => setCh(e.target.value)}>
              ${texts.map(c => html`<option value=${c.id}>#${c.name}</option>`)}
            </select>
          </label>`}
        ${kind === 'chess' && html`
        <div class="field-label">You play</div>
        <div class="seg-pick three">
          ${[['w', 'White', '♔'], ['b', 'Black', '♚'], ['r', 'Random', '?']].map(([v, label, icon]) => html`
            <button key=${v} class=${side === v ? 'active' : ''} onClick=${() => setSide(v)}><span class="seg-icon">${icon}</span>${label}</button>`)}
        </div>
        ${bot
          ? html`
            <div class="field-label">Strength</div>
            <div class="tc-pick">
              ${BOT_LEVELS.map(x => html`
                <button key=${x.id} class=${level === x.id ? 'active' : ''} onClick=${() => setLevel(x.id)}><b>${x.name}</b><small>${x.hint}</small></button>`)}
            </div>
            <p class="hint">Your app plays the computer's moves, so the game goes on whenever you're online. Everyone in the channel can watch.</p>`
          : html`
            <div class="field-label">Clock</div>
            <div class="tc-pick">
              ${TIME_CONTROLS.map(x => html`
                <button key=${x.id} class=${tc === x.id ? 'active' : ''} onClick=${() => setTc(x.id)}><b>${x.label}</b><small>${x.hint}</small></button>`)}
            </div>
            <p class="hint">${tc === 'none'
              ? 'Without a clock you can take as long as you like. The game waits while you are offline.'
              : 'Each app measures its own player\'s time, so clocks work even when your PCs\' times differ.'}</p>`}`}
      </div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${!ch} onClick=${start}>${kind === 'poker' ? 'Open table' : opp && !bot ? 'Send challenge' : 'Start game'}</button>
      </footer>
    <//>`
}

// ---------------------------------------------------------------- notifications

const GAME_OPS = new Set(['game.join', 'game.move', 'game.resign', 'game.draw', 'game.decline', 'game.flag', 'game.abort'])

// A desktop notification when something happens in a game I play, unless I'm looking at it
const turnSeen = new Set()

export function notifyGameOps (api, gid, ops) {
  const g = model.groups.get(gid)
  if (!g) return
  const me = model.me.key
  // poker: a sound (and a flash of the taskbar) when it becomes your turn
  for (const id of new Set(ops.filter(op => op.k.startsWith('poker.') && Date.now() - op.t < 60000).map(op => op.d.id))) {
    const st = model.gameState(g, id)
    if (!st || st.kind !== 'poker' || !model.isMyTurn(st)) continue
    const k = `${id}:${st.hand.h}:${st.hand.acts}`
    if (turnSeen.has(k)) continue
    turnSeen.add(k)
    playTone('turn')
    if (!model.ui.focused || model.ui.games?.id !== id) api.attention()
  }
  for (const op of ops) {
    if (!GAME_OPS.has(op.k) || op.a === me || Date.now() - op.t > 2 * 60 * 1000) continue
    const id = op.d.id
    const st = model.gameState(g, id)
    if (!st || (st.white !== me && st.black !== me && st.by !== me)) continue
    if (model.ui.focused && model.ui.games?.id === id) continue
    const who = model.memberName(g, op.a)
    let body = null
    if (st.status === 'over') body = gameStatus(g, st)
    else if (op.k === 'game.join') body = `${who} ${st.info.opp ? 'accepted your challenge' : 'joined your game'}. ${model.isMyTurn(st) ? 'Your move.' : ''}`
    else if (op.k === 'game.move' && model.isMyTurn(st)) body = `${who} played ${st.plies[st.plies.length - 1]?.san}. Your move.`
    else if (op.k === 'game.draw' && st.drawOffer === op.a) body = `${who} offers a draw`
    if (!body) continue
    api.attention()
    if (!model.settings.notifications) continue
    try {
      const n = new Notification('Chess · ' + model.groupName(g), { body, icon: model.memberAvatar(g, op.a) || undefined })
      n.onclick = () => { api.showWindow(); model.openGame(gid, id) }
    } catch {}
  }
}
