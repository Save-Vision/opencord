// Search a group's messages (all of them are on this PC anyway, so it's instant and offline).
//   words          all of them, in any order (accents and case don't matter)
//   from:name      written by someone (from:me, from:claude)
//   in:channel     in one channel
//   has:image|video|file|link|poll|game
//   before:2026-05-01 / after:2026-05-01
import { html, useState, useEffect, useRef, useMemo } from '../vendor/preact-htm.js'
import { model, fmtStamp } from '../lib/core.js'
import { parseQuery, searchMessages as search, fold } from '../lib/search.js'
import { Icon } from '../lib/icons.js'
import { Avatar, ClaudeAvatar, jumpToMessage } from './chat.js'

const MAX = 200

// The text around the first match, with matches marked
function Snippet ({ text, words }) {
  // markdown markers (**bold**, `code`, ||spoiler||) would only be noise in a one-line preview
  const plain = String(text || '').replace(/\*\*|__|~~|\|\||`+/g, '').replace(/\s+/g, ' ')
  const f = fold(plain)
  let start = 0
  if (words.length) {
    const i = f.indexOf(words[0])
    if (i > 60) start = i - 40
  }
  const cut = plain.slice(start, start + 220)
  const fcut = f.slice(start, start + 220)
  const marks = []
  for (const w of words) {
    if (!w) continue
    let i = fcut.indexOf(w)
    while (i >= 0) { marks.push([i, i + w.length]); i = fcut.indexOf(w, i + w.length) }
  }
  marks.sort((a, b) => a[0] - b[0])
  const parts = []
  let at = 0
  for (const [a, b] of marks) {
    if (a < at) continue
    parts.push(cut.slice(at, a), html`<mark>${cut.slice(a, b)}</mark>`)
    at = b
  }
  parts.push(cut.slice(at))
  return html`<span>${start ? '…' : ''}${parts}${start + 220 < plain.length ? '…' : ''}</span>`
}

export function SearchPanel ({ g }) {
  const [q, setQ] = useState(model.ui.search?.q || '')
  const [debounced, setDebounced] = useState(q)
  const input = useRef()
  useEffect(() => { input.current?.focus(); input.current?.select() }, [model.ui.search?.n])
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 120); return () => clearTimeout(t) }, [q])
  const results = useMemo(() => search(model, g, debounced, MAX), [debounced, g.msgById.size, g.id])
  const words = parseQuery(debounced).words
  const close = () => { model.ui.search = null; model.emit() }
  const open = (m) => {
    if (m.th && !m.also) { model.openThread(g.id, m.th); return }
    model.selectChannel(g.id, m.ch)
    model.ui.stage = null
    jumpToMessage(m.id)
  }
  const add = (s) => { setQ((q.trim() ? q.trim() + ' ' : '') + s); input.current?.focus() }
  return html`
    <aside class="search-panel">
      <div class="section-head search-head">
        <div class="search-box">
          <${Icon} name="search" size=${16} />
          <input ref=${input} value=${q} placeholder=${'Search ' + (g.dm ? 'this chat' : model.groupName(g))}
            onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && results[0]) open(results[0]) }} />
        </div>
        <button class="icon-btn small" title="Close (Esc)" onClick=${close}><${Icon} name="x" size=${16} /></button>
      </div>
      ${!debounced.trim()
        ? html`
          <div class="search-help">
            <p>Search every message on this PC. Filters:</p>
            <button onClick=${() => add('from:')}><code>from:</code> name</button>
            ${!g.dm && html`<button onClick=${() => add('in:')}><code>in:</code> channel</button>`}
            <button onClick=${() => add('has:image')}><code>has:</code> image, video, file, link, poll</button>
            <button onClick=${() => add('after:' + new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10))}><code>after:</code> / <code>before:</code> date</button>
          </div>`
        : html`
          <div class="search-count">${results.length >= MAX ? `Newest ${MAX} results` : results.length === 1 ? '1 result' : results.length + ' results'}</div>
          <div class="search-results">
            ${results.map(m => {
              const ch = g.channels.get(m.ch)
              return html`
                <button key=${m.id} class="search-hit" onClick=${() => open(m)}>
                  ${m.bot ? html`<${ClaudeAvatar} size=${28} />` : html`<${Avatar} name=${model.memberName(g, m.a)} color=${model.memberColor(g, m.a)} src=${model.memberAvatar(g, m.a)} size=${28} />`}
                  <div class="hit-body">
                    <div class="hit-head"><b style=${m.bot ? null : { color: model.memberColor(g, m.a) }}>${m.bot ? 'Claude' : model.memberName(g, m.a)}</b>${!g.dm && ch && html`<small>#${ch.name}${m.th && !m.also ? ' · thread' : ''}</small>`}<time>${fmtStamp(m.t)}</time></div>
                    <div class="hit-text">${m.poll ? html`<span class="muted">📊 </span><${Snippet} text=${m.poll.q} words=${words} />` : m.game ? html`<i class="muted">Game</i>` : html`<${Snippet} text=${m.text} words=${words} />`}${m.att.length > 0 && html`<span class="hit-att"><${Icon} name="clip" size=${12} /> ${m.att.map(a => a.n).join(', ')}</span>`}</div>
                  </div>
                </button>`
            })}
            ${!results.length && html`<div class="search-empty">Nothing found.</div>`}
          </div>`}
    </aside>`
}
