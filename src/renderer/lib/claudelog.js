// What Claude gets to read when someone asks it (lib/claude.js). Kept free of browser code so
// tests can check it.

const MAX_LINES = 40
const MAX_CHARS = 16000
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Whose messages Claude may read: the asker's own (and Claude's answers to them), and those of
// people who turned on "Claude may read my messages" in Settings > Privacy (off by default).
// Answers Claude gave someone else count as theirs.
export function claudeMayRead (model, g, m) {
  if (m.a === model.me.key) return true
  return !!g.members.get(m.a)?.claude
}

// The recent chat as plain lines, oldest first, ending with the message that asked. Only
// messages Claude may read go in, plus the one message the asker replied to (they picked it
// to show Claude) and the chain of replies above it.
export function transcript (model, g, msg) {
  const who = (m) => (m.bot ? 'Claude' : model.memberName(g, m.a) || 'Someone')
  let list
  if (msg.th) list = [g.msgById.get(msg.th), ...model.threadOf(g, msg.th)].filter(Boolean)
  else list = g.messages.get(msg.ch) || []
  const at = list.findIndex(m => m.id === msg.id)
  if (at >= 0) list = list.slice(0, at + 1)
  // the reply chain the asker pointed at: my message -> its parent -> … (a few steps)
  const chosen = new Set()
  for (let m = msg, i = 0; m?.re && i < 8; i++) {
    const p = g.msgById.get(m.re)
    if (!p || p.deleted) break
    // past the first step, the chain only goes on through messages Claude may read anyway
    if (i > 0 && !claudeMayRead(model, g, m)) break
    chosen.add(p.id)
    m = p
  }
  const readable = (m) => claudeMayRead(model, g, m) || chosen.has(m.id)
  const lines = []
  let budget = MAX_CHARS
  let skipped = 0
  for (let i = list.length - 1; i >= 0 && lines.length < MAX_LINES; i--) {
    const m = list[i]
    if (m.deleted) continue
    if (!readable(m)) { skipped++; continue }
    let body = m.game ? '[opened a game]' : m.poll ? `[poll] ${m.poll.q} (${m.poll.opts.map(o => o.t).join(' / ')})` : m.text
    if (m.att.length) body += (body ? ' ' : '') + m.att.map(a => `[attached ${a.n}]`).join(' ')
    const parent = m.re && g.msgById.get(m.re)
    if (parent && !parent.deleted) {
      body = readable(parent)
        ? `(replying to ${who(parent)}: "${parent.text.slice(0, 80).replace(/\s+/g, ' ')}") ` + body
        : '(replying to a message you can\'t see) ' + body
    }
    const line = `[${fmtTime(m.t)}] ${who(m)}: ${body}`
    budget -= line.length
    if (budget < 0 && lines.length) break
    lines.unshift(line)
  }
  // a message from before the window that the asker replied to
  for (const id of chosen) {
    if (list.some(m => m.id === id)) continue
    const p = g.msgById.get(id)
    lines.unshift(`[${fmtTime(p.t)}] ${who(p)}: ${p.text.slice(0, 2000)}`)
  }
  return { text: lines.join('\n'), skipped }
}
