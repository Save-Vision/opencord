// Polls: a message with a question and up to 10 answers. Everyone's newest vote counts; the
// author can end it early. Results are counted on each PC from the signed votes.
import { html, useState } from '../vendor/preact-htm.js'
import { model, act, append, rid } from '../lib/core.js'
import { Icon } from '../lib/icons.js'
import { Modal } from './modals.js'

const DURATIONS = [[0, 'No end'], [3600e3, '1 hour'], [4 * 3600e3, '4 hours'], [864e5, '1 day'], [3 * 864e5, '3 days'], [7 * 864e5, '1 week']]

function fmtLeft (ms) {
  if (ms < 60e3) return 'less than a minute left'
  if (ms < 3600e3) return Math.ceil(ms / 60e3) + ' min left'
  if (ms < 864e5) return Math.ceil(ms / 3600e3) + ' h left'
  return Math.ceil(ms / 864e5) + ' days left'
}

export function PollCard ({ g, m }) {
  const poll = m.poll
  const r = model.pollResults(g, m)
  const [showVoters, setShowVoters] = useState(false)
  const voted = r.mine.length > 0
  const reveal = voted || r.ended || m.a === model.me.key
  const vote = (id) => {
    if (r.ended || g.kickedMe || g.restoring) return
    let v
    if (poll.multi) v = r.mine.includes(id) ? r.mine.filter(x => x !== id) : [...r.mine, id]
    else v = r.mine[0] === id ? [] : [id]
    act(() => append(g.id, 'poll.vote', { id: m.id, v }))
  }
  const end = () => model.openModal('confirm', {
    title: 'End poll',
    body: 'End this poll now? Nobody can vote after that.',
    confirm: 'End poll',
    onConfirm: () => act(() => append(g.id, 'poll.close', { id: m.id }))
  })
  const most = Math.max(0, ...poll.opts.map(o => r.voters.get(o.id).length))
  return html`
    <div class="poll-card ${r.ended ? 'ended' : ''}">
      <div class="poll-q"><${Icon} name="poll" size=${18} /><b>${poll.q}</b></div>
      <small class="poll-sub">${poll.multi ? 'Pick any' : 'Pick one'}${r.ended ? ' · Ended' : r.endsAt ? ' · ' + fmtLeft(r.endsAt - Date.now()) : ''}</small>
      <div class="poll-opts">
        ${poll.opts.map(o => {
          const n = r.voters.get(o.id).length
          const pct = r.total ? Math.round(100 * n / r.total) : 0
          const mine = r.mine.includes(o.id)
          return html`
            <button key=${o.id} class="poll-opt ${mine ? 'mine' : ''} ${reveal && n === most && n > 0 ? 'top' : ''}" disabled=${r.ended} onClick=${() => vote(o.id)}
              title=${reveal ? r.voters.get(o.id).map(k => model.memberName(g, k)).join(', ') : ''}>
              ${reveal && html`<span class="poll-bar" style=${{ width: pct + '%' }} />`}
              <span class="poll-check">${mine && html`<${Icon} name="check" size=${14} />`}</span>
              <span class="poll-text">${o.t}</span>
              ${reveal && html`<span class="poll-n">${pct}%</span>`}
            </button>
            ${showVoters && n > 0 && html`<div class="poll-voters">${r.voters.get(o.id).map(k => model.memberName(g, k)).join(', ')}</div>`}`
        })}
      </div>
      <div class="poll-foot">
        <span>${r.total === 1 ? '1 vote' : r.total + ' votes'}${!reveal ? ' · vote to see results' : ''}</span>
        ${reveal && r.total > 0 && html`<a onClick=${() => setShowVoters(!showVoters)}>${showVoters ? 'Hide voters' : 'Show voters'}</a>`}
        ${m.a === model.me.key && !r.ended && html`<a onClick=${end}>End poll</a>`}
      </div>
    </div>`
}

export function PollModal ({ gid, ch, q: q0 = '' }) {
  const g = model.groups.get(gid)
  const [q, setQ] = useState(q0)
  const [opts, setOpts] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [dur, setDur] = useState(864e5)
  const clean = opts.map(o => o.trim()).filter(Boolean)
  const ok = q.trim() && clean.length >= 2 && new Set(clean).size === clean.length
  const setOpt = (i, v) => {
    const next = opts.slice()
    next[i] = v
    if (i === next.length - 1 && v && next.length < 10) next.push('')
    setOpts(next)
  }
  const create = async () => {
    if (!ok || !g) return
    const poll = { q: q.trim(), opts: clean.map((t, i) => ({ id: String(i + 1), t })), multi }
    if (dur) poll.ends = Date.now() + dur
    const done = await act(() => append(g.id, 'msg', { id: rid(), ch, text: '📊 ' + poll.q, poll }), 'Could not create the poll')
    if (done !== undefined) model.closeModal()
  }
  return html`
    <${Modal} title="Create a poll">
      <div class="modal-body poll-form">
        <label>Question<input value=${q} maxLength="300" autoFocus placeholder="What should we play tonight?" onInput=${(e) => setQ(e.target.value)} /></label>
        <div class="poll-edit-opts">
          <span class="label">Answers</span>
          ${opts.map((o, i) => html`
            <div class="row" key=${i}>
              <input value=${o} maxLength="100" placeholder=${'Answer ' + (i + 1)} onInput=${(e) => setOpt(i, e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter' && ok) create() }} />
              ${opts.length > 2 && html`<button class="icon-btn small" title="Remove" onClick=${() => setOpts(opts.filter((_, j) => j !== i))}><${Icon} name="x" size=${14} /></button>`}
            </div>`)}
        </div>
        <label class="check"><input type="checkbox" checked=${multi} onChange=${(e) => setMulti(e.target.checked)} /> Allow picking more than one answer</label>
        <label>Ends after
          <select value=${dur} onChange=${(e) => setDur(Number(e.target.value))}>${DURATIONS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
        </label>
      </div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${!ok} onClick=${create}>Post poll</button>
      </footer>
    <//>`
}
