// The poker table: seats around the felt, the board and pot in the middle, your cards and the
// betting buttons at the bottom. Rules and dealing are in lib/poker.js and lib/pokerplay.js.
import { html, useState, useEffect } from '../vendor/preact-htm.js'
import { model, act, append } from '../lib/core.js'
import { DM_TEXT } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { cardLabel, cardSuit, holeIdx, myOptions, potOf, waitingOn, STREETS, CHIP_OPTIONS, BLIND_OPTIONS, TIMER_OPTIONS } from '../lib/poker.js'
import { Avatar } from './chat.js'

const nameOf = (g, k) => k === model.me.key ? 'You' : model.memberName(g, k)
const fmtChips = (n) => Number(n || 0).toLocaleString()

export function Card ({ c, small = false, hidden = false, win = false }) {
  if (hidden || c == null) return html`<span class="pcard back ${small ? 'sm' : ''}" />`
  if (c < 0) return html`<span class="pcard bad ${small ? 'sm' : ''}" title="This card couldn't be opened">?</span>`
  const red = cardSuit(c) === 1 || cardSuit(c) === 2
  const label = cardLabel(c)
  return html`<span class="pcard ${red ? 'red' : ''} ${small ? 'sm' : ''} ${win ? 'win' : ''}"><b>${label.slice(0, -1)}</b><i>${label.slice(-1)}</i></span>`
}

// "Hand #4 · Bob to act", for cards and lists
export function pokerStatus (g, st) {
  if (st.status === 'missing') return 'This table is gone'
  const seated = st.seats.filter(s => !s.left).length
  if (st.status === 'over') return 'Table closed'
  const hand = st.hand
  if (hand && hand.stage !== 'done' && hand.stage !== 'void') {
    if (hand.stage === 'bet') return `Hand #${hand.h} · ${hand.toAct === model.me.key ? 'your turn' : nameOf(g, hand.toAct) + ' to act'}`
    return `Hand #${hand.h} · ${hand.stage === 'shuffle' || hand.stage === 'lock' ? 'shuffling' : 'dealing'}…`
  }
  if (!st.started) return `${seated}/${st.info.seats} seated · ${st.by === model.me.key ? 'start when everyone is in' : 'waiting for the host to start'}`
  if (seated < 2) return 'Waiting for players'
  return hand ? `Hand #${hand.h} done · next hand soon` : 'Dealing soon'
}

function resultText (g, hand) {
  const r = hand?.result
  if (!r) return ''
  if (r.void) return r.why === 'badkey' ? 'Hand cancelled: a card key was wrong. Bets went back.' : 'Hand cancelled: someone stopped responding. Bets went back.'
  const ws = r.winners
  const parts = ws.map(p => {
    const net = r.won[p]
    const how = r.ranking[p] ? ' with ' + r.ranking[p].name.toLowerCase() : ''
    return `${nameOf(g, p)} ${p === model.me.key ? 'win' : 'wins'} ${fmtChips(net)}${how}`
  })
  return parts.join(' · ')
}

// ---------------------------------------------------------------- the card in the chat

export function PokerCard ({ g, m }) {
  const st = model.gameState(g, m.id)
  if (!st || st.status === 'missing') return null
  const me = model.me.key
  const seated = st.seats.filter(s => !s.left)
  const mySeat = seated.find(s => s.key === me)
  const canSit = !mySeat && st.status !== 'over' && seated.length < st.info.seats && !g.kickedMe
  const open = () => model.openGame(g.id, m.id)
  const sit = async (e) => {
    e.stopPropagation()
    if (await act(() => append(g.id, 'poker.sit', { id: m.id }))) open()
  }
  return html`
    <div class="game-card poker-card ${model.isMyTurn(st) ? 'your-turn' : ''}" onClick=${open}>
      <div class="pc-felt">
        <div class="pc-cards"><${Card} c=${48} small /><${Card} c=${51} small /></div>
        <div class="pc-seats">${seated.slice(0, 8).map(s => html`<span key=${s.key} title=${model.memberName(g, s.key)}><${Avatar} name=${model.memberName(g, s.key)} color=${model.memberColor(g, s.key)} src=${model.memberAvatar(g, s.key)} size=${20} /></span>`)}</div>
      </div>
      <div class="gc-info">
        <div class="gc-kind"><${Icon} name="cards" size=${14} /> Texas Hold'em · ${st.info.sb}/${st.info.bb} · ${fmtChips(st.info.chips)} chips</div>
        <b class="gc-title">${model.memberName(g, st.by)}'s table</b>
        <span class="gc-status ${st.status === 'playing' ? 'active' : st.status}">${pokerStatus(g, st)}</span>
        ${mySeat && html`<small class="muted">Your stack: ${fmtChips(mySeat.stack)}</small>`}
        <div class="gc-actions">
          ${canSit
            ? html`<button class="btn primary sm" onClick=${sit}>Take a seat</button>`
            : html`<button class="btn sm ${model.isMyTurn(st) ? 'primary' : ''}" onClick=${(e) => { e.stopPropagation(); open() }}>${mySeat ? 'Open table' : 'Watch'}</button>`}
        </div>
      </div>
    </div>`
}

// ---------------------------------------------------------------- the table

function useTick (on, ms = 250) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => force(n => n + 1), ms)
    return () => clearInterval(t)
  }, [on])
}

export function PokerTable ({ g, id }) {
  const st = model.gameState(g, id)
  const gm = g.games.get(id)
  const me = model.me.key
  const hand = st?.hand
  const live = hand && hand.stage !== 'done' && hand.stage !== 'void'
  useTick(!!live && hand.stage === 'bet' && !!st.info.timer)
  if (!st || st.status === 'missing') {
    return html`<section class="games-view"><div class="center-card"><h2>This table is gone</h2><button class="btn" onClick=${() => model.openGames(g.id)}>Back to games</button></div></section>`
  }
  const send = (kind, data = {}) => act(() => append(g.id, 'poker.' + kind, { id, ...data }))
  const seats = st.seats.filter(s => !s.left)
  const mySeat = seats.find(s => s.key === me)
  const inHand = live && hand.players.includes(me)
  // who sits where: me at the bottom, everyone else clockwise from there
  const order = seats.map(s => s.key)
  if (hand) for (const p of hand.players) if (!order.includes(p)) order.push(p) // left mid-hand
  const start = Math.max(0, order.indexOf(me))
  const ring = order.map((_, i) => order[(start + i) % order.length])
  const n = Math.max(ring.length, 2)
  const place = (i) => {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / n
    return { left: (50 + 44 * Math.cos(a)) + '%', top: (50 + 40 * Math.sin(a)) + '%' }
  }
  const mine = (j) => gm.mine.get(hand.h + ':' + j)
  const pub = (j) => gm.cards.get(hand.h + ':' + j)
  const winners = new Set(hand?.result?.winners || [])
  const winCards = new Set()
  if (hand?.result && !hand.result.void) for (const p of winners) for (const c of hand.result.ranking[p]?.cards || []) winCards.add(c)
  const opts = myOptions(st, me)
  const w = live ? waitingOn(st) : null
  const isHost = st.by === me
  const canSit = !mySeat && st.status !== 'over' && seats.length < st.info.seats && !g.kickedMe

  const seatView = (k, i) => {
    const s = st.seats.find(x => x.key === k && !x.left) || st.seats.find(x => x.key === k)
    const inThis = hand && hand.players.includes(k)
    const pi = inThis ? hand.players.indexOf(k) : -1
    const folded = inThis && hand.folded.has(k)
    const stack = inThis && live ? hand.stack[k] : s?.stack ?? 0
    const bet = inThis && live ? hand.bets[k] : 0
    const turn = live && hand.stage === 'bet' && hand.toAct === k
    const last = inThis ? [...hand.log].reverse().find(e => e.e === 'act' && e.p === k && e.street === hand.street) : null
    const show = inThis && hand.shown[k]
    let cards = null
    if (inThis && hand.deck) {
      const idx = holeIdx(hand.n, pi)
      if (k === me) cards = idx.map(j => mine(j))
      else if (show) cards = show
      else if (!folded) cards = idx.map(j => pub(j) ?? null)
    }
    const left = timeLeft(st, hand, k)
    return html`
      <div key=${k} class="pk-seat ${k === me ? 'me' : ''} ${turn ? 'turn' : ''} ${folded ? 'folded' : ''} ${winners.has(k) && hand?.stage === 'done' ? 'winner' : ''} ${s?.away ? 'away' : ''} ${!s || s.left ? 'gone' : ''}" style=${place(i)}>
        ${cards && html`<div class="pk-hole ${k === me ? 'mine' : ''}">${cards.map((c, x) => html`<${Card} key=${x} c=${c} hidden=${c == null} small=${k !== me} win=${winCards.has(c)} />`)}</div>`}
        <div class="pk-plate">
          <${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${36} dot=${model.presence(g, k)} />
          <div class="pk-who"><b>${nameOf(g, k)}</b><small>${s?.away ? 'Sitting out' : !s || s.left ? 'Left' : fmtChips(stack)}</small></div>
          ${hand && live && pi === hand.b && html`<span class="pk-dealer" title="Dealer">D</span>`}
        </div>
        ${turn && left != null && html`<div class="pk-timer"><span style=${{ width: Math.max(0, Math.min(100, left.pct)) + '%' }} class=${left.pct < 25 ? 'low' : ''} /></div>`}
        ${(bet > 0 || last) && html`<div class="pk-bet">${last ? html`<span class="pk-act ${last.a}">${last.timeout ? 'Time · ' : ''}${last.allin ? 'All-in' : last.a === 'raise' ? (last.raised ? 'Raise' : 'Bet') : last.a[0].toUpperCase() + last.a.slice(1)}</span>` : ''}${bet > 0 && html`<span class="pk-chips">${fmtChips(bet)}</span>`}</div>`}
        ${show && hand.result?.ranking?.[k] && html`<div class="pk-hand-name">${hand.result.ranking[k].name}</div>`}
      </div>`
  }

  return html`
    <section class="games-view poker-view">
      <header class="chat-header">
        <button class="icon-btn" title="All games" onClick=${() => g.dm ? model.selectChannel(g.id, DM_TEXT) : model.openGames(g.id)}><${Icon} name="chevronLeft" /></button>
        <${Icon} name="cards" size=${20} class="dim" />
        <h2>${model.memberName(g, st.by)}'s table</h2>
        <span class="header-note">Hold'em · blinds ${st.info.sb}/${st.info.bb}${st.info.timer ? ` · ${st.info.timer} s to act` : ''} · cards dealt by mental poker: no app sees a card it shouldn't</span>
        <div class="spacer" />
      </header>
      <div class="pk-body">
        <div class="pk-felt">
          <div class="pk-center">
            <div class="pk-board">${[0, 1, 2, 3, 4].map(i => html`<${Card} key=${i} c=${hand && live || hand?.stage === 'done' ? hand.board[i] : null} hidden=${!hand || hand.board[i] == null} win=${hand && winCards.has(hand.board[i])} />`)}</div>
            ${hand && (live || hand.stage === 'done') && html`<div class="pk-pot">Pot ${fmtChips(potOf(hand))}</div>`}
            <div class="pk-status">${hand?.result ? resultText(g, hand) : live ? waitText(g, st, w) : pokerStatus(g, st)}</div>
          </div>
          ${ring.map((k, i) => seatView(k, i))}
          ${!ring.length && html`<div class="pk-empty">Nobody's seated yet</div>`}
        </div>
        ${inHand && opts && html`<${ActionBar} st=${st} opts=${opts} hand=${hand} onAct=${(a, to) => send('act', { h: hand.h, n: hand.acts, a, to })} />`}
        <div class="pk-controls">
          ${canSit && html`<button class="btn primary" onClick=${() => send('sit')}>Take a seat (${fmtChips(st.info.chips)} chips)</button>`}
          ${isHost && st.status !== 'over' && html`<button class="btn ${st.started ? '' : 'primary'}" disabled=${!st.started && seats.length < 2} onClick=${() => send('start', { on: !st.started })}>${st.started ? 'Pause after this hand' : seats.length < 2 ? 'Waiting for players…' : 'Start dealing'}</button>`}
          ${mySeat && mySeat.stack === 0 && !inHand && html`<button class="btn primary" onClick=${() => send('rebuy')}>Buy in again (${fmtChips(st.info.chips)})</button>`}
          ${mySeat && html`<button class="btn" onClick=${() => send('away', { on: !mySeat.away })}>${mySeat.away ? "I'm back" : 'Sit out'}</button>`}
          ${mySeat && html`<button class="btn" onClick=${() => model.openModal('confirm', { title: 'Leave the table?', body: inHand ? 'You fold this hand when it\'s your turn. Your chips stay on the table record; sitting down again starts with a new buy-in.' : 'Sitting down again starts with a new buy-in.', confirm: 'Leave', onConfirm: () => send('leave') })}>Leave table</button>`}
          ${isHost && st.status !== 'over' && html`<button class="btn danger-ghost" onClick=${() => model.openModal('confirm', { title: 'Close the table?', body: 'The current hand is played to the end, then the table closes for good.', confirm: 'Close table', danger: true, onConfirm: () => send('end') })}>Close table</button>`}
        </div>
        <${Standings} g=${g} st=${st} />
      </div>
    </section>`
}

function timeLeft (st, hand, k) {
  if (!hand || hand.stage !== 'bet' || hand.toAct !== k || !st.info.timer) return null
  const total = st.info.timer * 1000
  const left = total - (Date.now() - hand.since)
  return { ms: left, pct: (100 * left) / total }
}

function waitText (g, st, w) {
  if (!w) return ''
  const who = w.keys.map(k => nameOf(g, k)).join(', ')
  if (w.stage === 'shuffle') return `${who} ${w.keys[0] === model.me.key ? 'are' : 'is'} shuffling…`
  if (w.stage === 'lock') return `${who} ${w.keys[0] === model.me.key ? 'are' : 'is'} locking the deck…`
  if (w.stage === 'act') {
    const hand = st.hand
    return `${STREETS[hand.street]} · ${w.keys[0] === model.me.key ? 'your turn' : who + ' to act'}`
  }
  return w.keys.length ? `Waiting for ${who}…` : 'Opening cards…'
}

function ActionBar ({ st, opts, hand, onAct }) {
  const pot = opts.pot
  const [to, setTo] = useState(opts.minTo)
  useEffect(() => { setTo(opts.minTo) }, [hand.h, hand.acts])
  const clamp = (v) => Math.max(opts.minTo, Math.min(opts.maxTo, Math.round(v)))
  // pot-sized raise: call first, then raise by the pot after the call
  const potTo = (f) => clamp(opts.bet + f * (pot + (opts.bet - opts.mine)))
  const raiseLabel = opts.bet > 0 ? 'Raise to' : 'Bet'
  useEffect(() => {
    const k = (e) => {
      if (e.target.closest('input, textarea')) return
      if (e.key === 'f') onAct('fold')
      if (e.key === 'c') onAct(opts.check ? 'check' : 'call')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [opts])
  return html`
    <div class="pk-actions">
      <button class="btn danger-ghost" title="F" onClick=${() => onAct('fold')}>Fold</button>
      <button class="btn" title="C" onClick=${() => onAct(opts.check ? 'check' : 'call')}>${opts.check ? 'Check' : opts.allinCall ? `All-in ${fmtChips(opts.call)}` : `Call ${fmtChips(opts.call)}`}</button>
      ${opts.raise && html`
        <div class="pk-raise">
          <div class="pk-presets">
            <button onClick=${() => setTo(opts.minTo)}>Min</button>
            <button onClick=${() => setTo(potTo(0.5))}>½ pot</button>
            <button onClick=${() => setTo(potTo(1))}>Pot</button>
            <button onClick=${() => setTo(opts.maxTo)}>All-in</button>
          </div>
          <input type="range" min=${opts.minTo} max=${opts.maxTo} step=${st.info.sb} value=${to} onInput=${(e) => setTo(clamp(+e.target.value))} />
          <input type="number" min=${opts.minTo} max=${opts.maxTo} value=${to} onChange=${(e) => setTo(clamp(+e.target.value))} />
          <button class="btn primary" onClick=${() => onAct('raise', to === opts.maxTo ? opts.maxTo : to)}>${to === opts.maxTo ? `All-in ${fmtChips(to)}` : `${raiseLabel} ${fmtChips(to)}`}</button>
        </div>`}
    </div>`
}

// Chips won or lost so far, per player
function Standings ({ g, st }) {
  const rows = st.seats.map(s => ({ key: s.key, stack: s.stack, net: s.stack - s.buyins * st.info.chips, left: s.left, buyins: s.buyins }))
  if (!rows.length) return null
  rows.sort((a, b) => b.net - a.net)
  return html`
    <div class="pk-standings">
      <h4>Standings ${st.hands ? html`<small>${st.hands} hand${st.hands > 1 ? 's' : ''}</small>` : ''}</h4>
      ${rows.map(r => html`
        <div key=${r.key} class="pk-row ${r.left ? 'left' : ''}">
          <span>${nameOf(g, r.key)}${r.buyins > 1 ? html`<small> · ${r.buyins} buy-ins</small>` : ''}</span>
          <b class=${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}>${r.net > 0 ? '+' : ''}${fmtChips(r.net)}</b>
        </div>`)}
    </div>`
}

// ---------------------------------------------------------------- new table (part of the new game dialog)

export function PokerOptions ({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch })
  return html`
    <div class="field-label">Chips per buy-in</div>
    <div class="seg-pick four">${CHIP_OPTIONS.map(c => html`<button key=${c} class=${value.chips === c ? 'active' : ''} onClick=${() => set({ chips: c, ...(value.bb > c / 10 ? { sb: 5, bb: 10 } : {}) })}>${fmtChips(c)}</button>`)}</div>
    <div class="field-label">Blinds</div>
    <div class="seg-pick four">${BLIND_OPTIONS.filter(([, bb]) => bb <= value.chips / 10).map(([sb, bb]) => html`<button key=${bb} class=${value.bb === bb ? 'active' : ''} onClick=${() => set({ sb, bb })}>${sb}/${bb}</button>`)}</div>
    <div class="grid2">
      <label>Time to act
        <select value=${value.timer} onChange=${(e) => set({ timer: +e.target.value })}>${TIMER_OPTIONS.map(t => html`<option value=${t}>${t ? t + ' seconds' : 'No limit'}</option>`)}</select>
      </label>
      <label>Seats
        <select value=${value.seats} onChange=${(e) => set({ seats: +e.target.value })}>${[2, 3, 4, 5, 6, 7, 8].map(s => html`<option value=${s}>${s} players</option>`)}</select>
      </label>
    </div>
    <p class="hint">No-limit Texas Hold'em for chips (no real money). The deck is shuffled by all players' apps together with mental poker, so no app, not even a modified one, can see cards it shouldn't. Everyone needs to stay online during a hand.</p>`
}

export const pokerRowInfo = (g, st) => `${st.info.sb}/${st.info.bb} · ${st.seats.filter(s => !s.left).length} seated · ${st.hands} hand${st.hands === 1 ? '' : 's'}`
