// Message search (views/search.js):
//   words          all of them, in any order (accents and case don't matter)
//   from:name      written by someone (from:me, from:claude)
//   in:channel     in one channel
//   has:image|video|file|link|poll|game
//   before:2026-05-01 / after:2026-05-01

export const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export function parseQuery (q) {
  const out = { words: [], from: [], in: [], has: [], before: null, after: null }
  for (const tok of String(q || '').match(/\S+:"[^"]*"|"[^"]*"|\S+/g) || []) {
    const m = /^(from|in|has|before|after):(.+)$/i.exec(tok)
    const val = m ? m[2].replace(/^"|"$/g, '') : tok.replace(/^"|"$/g, '')
    if (!m) { if (val) out.words.push(fold(val)); continue }
    const k = m[1].toLowerCase()
    if (k === 'before' || k === 'after') {
      const t = Date.parse(val)
      if (Number.isFinite(t)) out[k] = k === 'before' ? t : t + 86400000 - 1
    } else out[k].push(fold(val.replace(/^[#@]/, '')))
  }
  return out
}

const HAS = {
  image: (m) => m.att.some(a => /^image\//.test(a.m)),
  video: (m) => m.att.some(a => /^video\//.test(a.m)),
  file: (m) => m.att.length > 0,
  link: (m) => /https?:\/\//i.test(m.text),
  poll: (m) => !!m.poll,
  game: (m) => !!m.game
}

export function searchMessages (model, g, q, max = 200) {
  const p = parseQuery(q)
  if (!p.words.length && !p.from.length && !p.in.length && !p.has.length && !p.before && !p.after) return []
  const nameOf = (m) => m.bot ? 'claude' : fold(model.memberName(g, m.a))
  const out = []
  for (const m of g.msgById.values()) {
    if (m.deleted || m.tomb || !m.ch) continue
    if (p.before && m.t >= p.before) continue
    if (p.after && m.t <= p.after) continue
    if (p.from.length && !p.from.some(f => (f === 'me' && m.a === model.me.key && !m.bot) || nameOf(m).startsWith(f))) continue
    if (p.in.length) {
      const ch = fold(g.channels.get(m.ch)?.name)
      if (!p.in.some(x => ch.startsWith(x))) continue
    }
    if (p.has.length && !p.has.every(h => HAS[h]?.(m))) continue
    if (p.words.length) {
      const hay = fold(m.text + ' ' + m.att.map(a => a.n).join(' ') + (m.poll ? ' ' + m.poll.q + ' ' + m.poll.opts.map(o => o.t).join(' ') : ''))
      if (!p.words.every(w => hay.includes(w))) continue
    }
    out.push(m)
  }
  out.sort((a, b) => b.t - a.t)
  return out.slice(0, max)
}
