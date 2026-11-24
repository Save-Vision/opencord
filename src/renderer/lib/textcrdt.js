// Shared text for focus documents: everyone can type at the same time, and every app ends up
// with the same text no matter in which order the edits arrive (an RGA sequence CRDT).
//
// Every character has an id [counter, author]. The counter is a Lamport clock: higher than any
// counter the author had seen when typing it. A run of typed text is stored as one insert:
//   [counter of the first character, the id it was typed after (or none: the start), text]
// and its characters get counter, counter + 1, ... Deleting only marks ids as gone.
//
// Placing a character typed after X: go right from X and skip every character with a bigger
// id; those were typed later (or at the same time, and win the tie by author). That rule
// gives the same order everywhere. An insert whose X hasn't arrived yet waits for it.
//
// In ops (model.js 'doc.edit'): d.r = [[counter, refCounter, refAuthor, text], ...] for runs by
// the op's author (refCounter 0 = the start), d.x = [[counter, author, count], ...] for deleted
// ranges of consecutive ids.

const key = (c, a) => c + ':' + a
const greater = (c1, a1, c2, a2) => c1 > c2 || (c1 === c2 && a1 > a2)

export const MAX_RUN = 8000 // characters per run, so a big paste still fits in ops

export class TextDoc {
  constructor () {
    this.nodes = [] // { c, a, ch, del }
    this.byKey = new Map()
    this.deleted = new Set() // keys deleted, also ones that haven't arrived yet
    this.waiting = new Map() // ref key -> runs waiting for it
    this.maxC = 0
    this._text = ''
    this._ids = []
    this.dirty = false
    this.version = 0
  }

  has (c, a) { return this.byKey.has(key(c, a)) }

  // A run [c, a, ref = [c, a] | null, text]. Returns false if it waits for its ref.
  insertRun (c, a, ref, text) {
    if (typeof text !== 'string' || !text.length || !(c > 0) || typeof a !== 'string') return true
    if (this.has(c, a)) return true // already have it (our own op coming back, or a resend)
    let pos = 0
    if (ref) {
      const r = this.byKey.get(key(ref[0], ref[1]))
      if (!r) {
        const k = key(ref[0], ref[1])
        if (!this.waiting.has(k)) this.waiting.set(k, [])
        this.waiting.get(k).push([c, a, ref, text])
        return false
      }
      pos = this.nodes.indexOf(r) + 1
    }
    while (pos < this.nodes.length && greater(this.nodes[pos].c, this.nodes[pos].a, c, a)) pos++
    const run = []
    for (let i = 0; i < text.length; i++) {
      const n = { c: c + i, a, ch: text[i], del: false }
      if (this.deleted.has(key(n.c, a))) n.del = true
      this.byKey.set(key(n.c, a), n)
      run.push(n)
    }
    this.nodes.splice(pos, 0, ...run)
    if (c + text.length - 1 > this.maxC) this.maxC = c + text.length - 1
    this.dirty = true
    // anything that was waiting for one of these characters can go in now
    for (const n of run) {
      const k = key(n.c, n.a)
      const w = this.waiting.get(k)
      if (w) { this.waiting.delete(k); for (const x of w) this.insertRun(...x) }
    }
    return true
  }

  deleteRange (c, a, count) {
    for (let i = 0; i < count; i++) {
      const k = key(c + i, a)
      this.deleted.add(k)
      const n = this.byKey.get(k)
      if (n && !n.del) { n.del = true; this.dirty = true }
    }
  }

  // Applies a 'doc.edit' op's data, written by `author`
  applyOp (author, d) {
    for (const r of Array.isArray(d?.r) ? d.r : []) {
      if (!Array.isArray(r) || r.length !== 4) continue
      const [c, rc, ra, text] = r
      if (!Number.isInteger(c) || !Number.isInteger(rc) || typeof text !== 'string' || text.length > MAX_RUN) continue
      this.insertRun(c, author, rc > 0 && typeof ra === 'string' ? [rc, ra] : null, text)
    }
    for (const x of Array.isArray(d?.x) ? d.x : []) {
      if (!Array.isArray(x) || x.length !== 3) continue
      const [c, a, count] = x
      if (Number.isInteger(c) && typeof a === 'string' && Number.isInteger(count) && count > 0 && count <= 1e6) this.deleteRange(c, a, count)
    }
  }

  _refresh () {
    if (!this.dirty) return
    let t = ''
    const ids = []
    for (const n of this.nodes) if (!n.del) { t += n.ch; ids.push(n) }
    this._text = t
    this._ids = ids
    this.dirty = false
    this.version++
  }

  text () { this._refresh(); return this._text }
  // The visible characters (in order), for mapping positions to ids
  visible () { this._refresh(); return this._ids }

  // ---- local typing: each returns what goes into the op ----

  // Inserts `text` at visible index `at`, typed by `me`. Returns runs for d.r.
  localInsert (at, text, me) {
    if (!text) return []
    const vis = this.visible()
    let ref = at > 0 ? vis[at - 1] : null
    const out = []
    for (let i = 0; i < text.length; i += MAX_RUN) {
      const part = text.slice(i, i + MAX_RUN)
      const c = this.maxC + 1
      this.insertRun(c, me, ref ? [ref.c, ref.a] : null, part)
      out.push([c, ref ? ref.c : 0, ref ? ref.a : '', part])
      ref = this.byKey.get(key(c + part.length - 1, me))
    }
    return out
  }

  // Deletes `count` visible characters from index `at`. Returns ranges for d.x.
  localDelete (at, count) {
    if (count <= 0) return []
    const gone = this.visible().slice(at, at + count)
    const out = []
    for (const n of gone) {
      const last = out[out.length - 1]
      if (last && last[1] === n.a && last[0] + last[2] === n.c) last[2]++
      else out.push([n.c, n.a, 1])
    }
    for (const [c, a, k] of out) this.deleteRange(c, a, k)
    return out
  }

  // Turns the textarea's new value into edits: what changed between the old and new text
  // (one replaced span; typing, pasting and deleting are all like that)
  localReplace (value, me) {
    const old = this.text()
    if (value === old) return null
    let p = 0
    const max = Math.min(old.length, value.length)
    while (p < max && old[p] === value[p]) p++
    let s = 0
    while (s < max - p && old[old.length - 1 - s] === value[value.length - 1 - s]) s++
    const x = this.localDelete(p, old.length - s - p)
    const r = this.localInsert(p, value.slice(p, value.length - s), me)
    return { r, x }
  }
}

// Where a caret at `index` in `oldIds` belongs in the new text: just after the same character
// (or the nearest one before it that still exists).
export function mapCaret (oldIds, newDoc, index) {
  const vis = newDoc.visible()
  if (index <= 0) return 0
  const pos = new Map(vis.map((n, i) => [n, i]))
  for (let i = Math.min(index, oldIds.length) - 1; i >= 0; i--) {
    const n = oldIds[i]
    if (pos.has(n)) return pos.get(n) + 1
  }
  return 0
}

// Merges two pending edits into one op's data
export function mergeEdits (a, b) {
  if (!a) return b
  if (!b) return a
  return { r: [...a.r, ...b.r], x: [...a.x, ...b.x] }
}

// Splits one edit into ops that each fit
export const OP_BUDGET = 40000 // bytes of edits per op (ops are limited to 64 KB)

export function chunkEdit (ed, budget = OP_BUDGET) {
  const out = []
  let cur = { r: [], x: [] }
  let size = 0
  const push = (kind, item) => {
    const n = JSON.stringify(item).length + 1
    if (size + n > budget && (cur.r.length || cur.x.length)) { out.push(cur); cur = { r: [], x: [] }; size = 0 }
    cur[kind].push(item)
    size += n
  }
  // deletions first: they refer to characters that already exist
  for (const x of ed.x) push('x', x)
  for (const r of ed.r) push('r', r)
  if (cur.r.length || cur.x.length) out.push(cur)
  return out
}
