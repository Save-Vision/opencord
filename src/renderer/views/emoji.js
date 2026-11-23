// Emoji picker (composer and reactions) and :shortcode: suggestions.
// Data: unicode-emoji-json (all emoji of the current Unicode version, grouped like on phones).
import { html, useState, useEffect, useRef, useMemo } from '../vendor/preact-htm.js'
import { Icon } from '../lib/icons.js'

const CATEGORY_ICON = { 'Smileys & Emotion': '😀', 'People & Body': '👋', 'Animals & Nature': '🐻', 'Food & Drink': '🍕', 'Travel & Places': '✈️', Activities: '⚽', Objects: '💡', Symbols: '❤️', Flags: '🏁' }
// A few names people type out of habit that aren't in the Unicode names
const ALIASES = { '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', joy: '😂', lol: '😂', heart: '❤️', ok: '👌', sob: '😭', cry: '😢', tada: '🎉', fire: '🔥', eyes: '👀', skull: '💀', pray: '🙏', clap: '👏', rofl: '🤣', smile: '😄', wink: '😉', think: '🤔', thinking: '🤔', shrug: '🤷', facepalm: '🤦', wave: '👋', rocket: '🚀', 100: '💯', check: '✅', x: '❌', sweat_smile: '😅', grin: '😁', sunglasses: '😎', angry: '😠', rage: '😡', poop: '💩', party: '🥳', sleeping: '😴', star: '⭐', sparkles: '✨' }
const RECENT_KEY = 'od.recentEmoji'

let groups = null
let byEmoji = null
let loading = null

export function loadEmoji () {
  if (groups) return Promise.resolve(groups)
  if (!loading) {
    loading = fetch('vendor/emoji.json').then(r => r.json()).then((raw) => {
      groups = raw.map(g => ({ name: g.name, emojis: g.emojis.map(e => ({ e: e.emoji, n: e.name, s: e.slug })) }))
      byEmoji = new Map()
      for (const g of groups) for (const e of g.emojis) byEmoji.set(e.e, e)
      return groups
    })
    loading.catch(() => { loading = null })
  }
  return loading
}

export function recentEmoji () {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24) } catch { return [] }
}

export function rememberEmoji (e) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter(x => x !== e)].slice(0, 24))) } catch {}
}

// Best matches for a :shortcode prefix (needs loadEmoji() to have finished)
export function searchEmoji (query, limit = 8) {
  const q = String(query || '').toLowerCase().replace(/^:/, '').replace(/[\s-]+/g, '_')
  if (!q || !groups) return []
  const scored = []
  if (ALIASES[q]) scored.push({ e: ALIASES[q], s: q, score: -1 })
  for (const g of groups) {
    for (const e of g.emojis) {
      const i = e.s.indexOf(q)
      if (i < 0) continue
      // prefer matches at the start of the name, then at the start of a word, then shorter names
      const score = (i === 0 ? 0 : e.s[i - 1] === '_' ? 1 : 2) * 1000 + e.s.length
      scored.push({ e: e.e, s: e.s, score })
    }
  }
  for (const [alias, e] of Object.entries(ALIASES)) if (alias !== q && alias.startsWith(q)) scored.push({ e, s: alias, score: 500 + alias.length })
  scored.sort((a, b) => a.score - b.score)
  const seen = new Set()
  const out = []
  for (const x of scored) {
    if (seen.has(x.e)) continue
    seen.add(x.e)
    out.push(x)
    if (out.length >= limit) break
  }
  return out
}

function useOutsideClose (ref, onClose) {
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('[data-emoji-toggle]')) onClose() }
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc, true) }
  }, [])
}

// The full picker. Shift-click keeps it open to pick several.
export function EmojiPanel ({ onPick, onClose, class: cls = '' }) {
  const ref = useRef()
  const gridRef = useRef()
  const [data, setData] = useState(groups)
  const [q, setQ] = useState('')
  const [hover, setHover] = useState(null)
  const [active, setActive] = useState(0)
  useOutsideClose(ref, onClose)
  useEffect(() => { if (!data) loadEmoji().then(setData, () => setData([])) }, [])

  const sections = useMemo(() => {
    if (!data) return []
    if (q.trim()) {
      const words = q.toLowerCase().trim().split(/\s+/)
      const hits = []
      for (const g of data) for (const e of g.emojis) if (words.every(w => e.n.includes(w) || e.s.includes(w))) hits.push(e)
      for (const [alias, e] of Object.entries(ALIASES)) if (alias.startsWith(q.toLowerCase().trim()) && !hits.some(h => h.e === e)) hits.unshift(byEmoji.get(e) || { e, n: alias, s: alias })
      return [{ name: hits.length ? 'Results' : 'No emoji found', emojis: hits.slice(0, 300) }]
    }
    const rec = recentEmoji().map(e => byEmoji?.get(e) || { e, n: '', s: '' })
    return [...(rec.length ? [{ name: 'Recently used', icon: '🕘', emojis: rec }] : []), ...data.map(g => ({ ...g, icon: CATEGORY_ICON[g.name] }))]
  }, [data, q])

  const pick = (e, ev) => {
    rememberEmoji(e.e)
    onPick(e.e)
    if (!ev.shiftKey) onClose()
  }
  const jump = (i) => {
    const el = gridRef.current?.querySelector(`[data-sec="${i}"]`)
    if (el) gridRef.current.scrollTop = el.offsetTop - gridRef.current.offsetTop
  }
  const onScroll = () => {
    const grid = gridRef.current
    if (!grid) return
    let cur = 0
    for (const el of grid.querySelectorAll('[data-sec]')) if (el.offsetTop - grid.offsetTop <= grid.scrollTop + 8) cur = +el.dataset.sec
    if (cur !== active) setActive(cur)
  }

  return html`
    <div class="emoji-panel ${cls}" ref=${ref} onMouseDown=${(e) => e.stopPropagation()}>
      <div class="ep-search">
        <${Icon} name="search" size=${16} />
        <input autoFocus placeholder="Find the perfect emoji" value=${q} onInput=${(e) => { setQ(e.target.value); if (gridRef.current) gridRef.current.scrollTop = 0 }}
          onKeyDown=${(e) => { if (e.key === 'Enter' && sections[0]?.emojis[0]) pick(sections[0].emojis[0], e) }} />
      </div>
      ${!q.trim() && html`
        <div class="ep-cats">
          ${sections.map((s, i) => html`<button key=${s.name} class=${i === active ? 'active' : ''} title=${s.name} onClick=${() => jump(i)}>${s.icon || '•'}</button>`)}
        </div>`}
      <div class="ep-grid" ref=${gridRef} onScroll=${onScroll}>
        ${!data && html`<p class="muted ep-empty">Loading…</p>`}
        ${sections.map((s, i) => html`
          <div key=${s.name} class="ep-section" data-sec=${i}>
            <h5>${s.name}</h5>
            <div class="ep-emojis">
              ${s.emojis.map(e => html`<button key=${e.e} title=${e.n ? ':' + e.s + ':' : ''} onMouseEnter=${() => setHover(e)} onClick=${(ev) => pick(e, ev)}>${e.e}</button>`)}
            </div>
          </div>`)}
      </div>
      <div class="ep-foot">${hover ? html`<span class="ep-big">${hover.e}</span><span>${hover.n ? ':' + hover.s + ':' : ''}</span>` : html`<span class="muted">Shift-click to pick more than one</span>`}</div>
    </div>`
}

// Popup above the composer while typing ":word"
export function EmojiSuggest ({ items, index, onPick }) {
  if (!items.length) return null
  return html`
    <div class="emoji-suggest">
      <div class="es-head">Emoji matching <b>:${items.query}</b></div>
      ${items.map((x, i) => html`
        <button key=${x.e} class=${i === index ? 'active' : ''} onMouseDown=${(e) => { e.preventDefault(); onPick(x) }}>
          <span class="es-emoji">${x.e}</span><span>:${x.s}:</span>
        </button>`)}
    </div>`
}
