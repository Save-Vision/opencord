// Derived application state. Every peer replays the same set of signed ops in a
// deterministic way, so everyone converges on identical channels/messages/profiles.

const MAX_TEXT = 4000
const later = (t1, a1, t2, a2) => t1 > t2 || (t1 === t2 && a1 > a2)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
// Same rule as the main process (store.js): a small raster image as a data URL.
export const isAvatarUrl = (s) => typeof s === 'string' && s.length <= 48 * 1024 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s)

export const shortKey = (key) => key ? key.slice(0, 4) + '…' + key.slice(-4) : ''
export const HOME = 'home' // ui.gid for the friends page
export const DM_TEXT = 'dm'
export const DM_CALL = 'call'
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)
const isThumb = (s) => typeof s === 'string' && s.length <= 40 * 1024 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s)
const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)))

// A link preview attached by the message's author (see main/linkpreview.js)
function cleanEmbed (d, a) {
  const url = str(d.url, 2000)
  if (!/^https?:\/\//i.test(url)) return null
  const e = {
    a,
    url,
    kind: d.kind === 'image' ? 'image' : 'link',
    site: str(d.site, 100),
    title: str(d.title, 300),
    description: str(d.description, 500),
    color: /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : null,
    large: !!d.large,
    video: !!d.video
  }
  if (isThumb(d.image)) { e.image = d.image; e.w = num(d.w, 4096); e.h = num(d.h, 4096) }
  return e.title || e.image ? e : null
}

function setMembership (g, m) {
  if (!m) return
  g.owner = isKey(m.owner) ? m.owner : null
  g.admins = new Set((m.admins || []).filter(isKey))
  g.removed = new Set((m.removed || []).filter(isKey))
  g.kickedMe = !!m.kickedMe
}

function newGroup ({ id, nameHint, joinedAt, dm, membership }) {
  const g = {
    id,
    dm: isKey(dm) ? dm : null, // private chat with this friend
    nameHint: nameHint || (dm ? '' : 'Group'),
    name: null,
    nameTs: [-1, ''],
    joinedAt,
    channels: new Map(),
    members: new Map(),
    messages: new Map(),
    msgById: new Map(),
    pendingReactions: new Map(),
    seen: new Set(),
    online: new Map(),
    voice: new Map(),
    typing: new Map(),
    lastMsgTs: 0,
    icon: null,
    iconTs: [-1, ''],
    pins: new Map(), // msgId -> { on, t, a }
    embeds: new Map(), // msgId -> Map(url -> embed)
    mutes: new Map(), // key -> [{ on, t, a }]: server mutes (who may mute is checked when read)
    owner: null,
    admins: new Set(),
    removed: new Set(),
    kickedMe: false
  }
  if (g.dm) {
    // A private chat has one text and one call channel, implied rather than created by ops
    g.channels.set(DM_TEXT, { id: DM_TEXT, name: 'messages', kind: 'text', createdAt: 0, createdBy: '', nameTs: [0, ''], deleted: false })
    g.channels.set(DM_CALL, { id: DM_CALL, name: 'Call', kind: 'voice', createdAt: 0, createdBy: '', nameTs: [0, ''], deleted: false })
  }
  setMembership(g, membership)
  return g
}

export class Model {
  constructor () {
    this.groups = new Map()
    this.listeners = new Set()
    this.me = null
    this.settings = null
    this.blobs = new Map() // hash -> { state: 'have'|'fetching'|'missing'|'error', r, s, err }
    this.friends = { code: '', incoming: [], outgoing: [] }
    this.ui = {
      gid: null,
      chByGroup: {},
      modal: null,
      toasts: [],
      focused: document.hasFocus(),
      replyTo: null,
      editing: null
    }
    this._scheduled = false
    try { Object.assign(this.ui.chByGroup, JSON.parse(localStorage.getItem('od.chByGroup') || '{}')) } catch {}
    try { this.ui.gid = localStorage.getItem('od.gid') } catch {}
    try { this.lastRead = JSON.parse(localStorage.getItem('od.lastRead') || '{}') } catch { this.lastRead = {} }
    setInterval(() => this._expireTyping(), 1000)
  }

  subscribe (fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  emit () {
    if (this._scheduled) return
    this._scheduled = true
    queueMicrotask(() => {
      this._scheduled = false
      for (const fn of this.listeners) fn()
    })
  }

  // ---- groups & ops ----

  addGroup (payload) {
    let g = this.groups.get(payload.id)
    if (!g) {
      g = newGroup(payload)
      this.groups.set(payload.id, g)
    } else if (payload.membership) {
      setMembership(g, payload.membership)
    }
    this.applyOps(payload.id, payload.ops || [])
    for (const info of payload.online || []) if (!g.online.has(info.key)) g.online.set(info.key, info)
    return g
  }

  removeGroup (id) {
    const g = this.groups.get(id)
    this.groups.delete(id)
    if (this.ui.gid === id) this.ui.gid = g?.dm ? HOME : this.groupsList()[0]?.id || null
    this.emit()
  }

  setMembership (gid, info) {
    const g = this.groups.get(gid)
    if (!g) return
    setMembership(g, info)
    this.emit()
  }

  setFriends (f) {
    this.friends = { code: f?.code || '', incoming: f?.incoming || [], outgoing: f?.outgoing || [] }
    this.emit()
  }

  // Regular groups (not private chats), oldest first
  groupsList () { return [...this.groups.values()].filter(g => !g.dm).sort((a, b) => a.joinedAt - b.joinedAt) }
  dmsList () { return [...this.groups.values()].filter(g => g.dm).sort((a, b) => (b.lastMsgTs || b.joinedAt) - (a.lastMsgTs || a.joinedAt)) }
  dmWith (key) { for (const g of this.groups.values()) if (g.dm === key) return g; return null }
  // Accepted = the friend has posted into the private chat (their app sends a profile op on accept)
  isFriend (key) { const g = this.dmWith(key); return !!g && g.members.has(key) }

  // ---- roles & moderation (same rules as main/store.js) ----

  canModerate (g, actor, target) {
    if (!g || g.dm || !isKey(target) || actor === target || target === g.owner) return false
    if (actor === g.owner) return true
    return g.admins.has(actor) && !g.admins.has(target)
  }

  roleOf (g, key) { return key === g?.owner ? 'owner' : g?.admins.has(key) ? 'admin' : 'member' }

  // Server mute: the newest mute/unmute by someone who may (still) moderate this person
  isServerMuted (g, key) {
    const list = g?.mutes.get(key)
    if (!list) return false
    let best = null
    for (const m of list) if (this.canModerate(g, m.a, key) && (!best || later(m.t, m.a, best.t, best.a))) best = m
    return !!best?.on
  }

  pinnedIn (g, chId) {
    const out = []
    for (const [id, p] of g.pins) {
      const m = g.msgById.get(id)
      if (p.on && m && !m.deleted && m.ch === chId) out.push({ m, t: p.t, by: p.a })
    }
    return out.sort((a, b) => b.t - a.t)
  }

  isPinned (g, id) { return !!g.pins.get(id)?.on }

  embedsOf (g, m) {
    const map = g.embeds.get(m.id)
    if (!map) return []
    return [...map.values()].filter(e => e.a === m.a).slice(0, 3)
  }

  applyOps (gid, ops) {
    const g = this.groups.get(gid)
    if (!g) return []
    const fresh = []
    for (const op of ops) {
      const id = op.a + ':' + op.s
      if (g.seen.has(id)) continue
      g.seen.add(id)
      this._apply(g, op)
      fresh.push(op)
    }
    if (fresh.length) this.emit()
    return fresh
  }

  _member (g, key, t) {
    let m = g.members.get(key)
    if (!m) {
      m = { key, name: '', color: '#8b93a1', profileTs: -1, firstSeen: t }
      g.members.set(key, m)
    }
    if (t < m.firstSeen) m.firstSeen = t
    return m
  }

  _apply (g, op) {
    const d = op.d || {}
    this._member(g, op.a, op.t)
    switch (op.k) {
      case 'group.init':
      case 'group.rename': {
        const name = str(d.name, 64).trim()
        if (name && later(op.t, op.a, ...g.nameTs)) { g.name = name; g.nameTs = [op.t, op.a] }
        break
      }
      case 'group.icon': {
        if (g.dm || !later(op.t, op.a, ...g.iconTs)) break
        if (d.icon !== null && !isAvatarUrl(d.icon)) break
        g.icon = d.icon
        g.iconTs = [op.t, op.a]
        break
      }
      case 'msg.pin': {
        const id = str(d.id, 32)
        const prev = g.pins.get(id)
        if (id && (!prev || later(op.t, op.a, prev.t, prev.a))) g.pins.set(id, { on: !!d.on, t: op.t, a: op.a })
        break
      }
      case 'msg.embed': {
        const id = str(d.id, 32)
        const e = id && cleanEmbed(d, op.a)
        if (!e) break
        let map = g.embeds.get(id)
        if (!map) { map = new Map(); g.embeds.set(id, map) }
        if (map.size < 5) map.set(e.url, e)
        break
      }
      case 'voice.mute': {
        if (!isKey(d.key)) break
        const list = g.mutes.get(d.key) || []
        list.push({ on: !!d.on, t: op.t, a: op.a })
        g.mutes.set(d.key, list)
        break
      }
      case 'channel.create': {
        const id = str(d.id, 32)
        if (!id || g.channels.has(id) || g.dm) break
        g.channels.set(id, {
          id,
          name: str(d.name, 48).trim() || 'channel',
          kind: d.kind === 'voice' ? 'voice' : 'text',
          createdAt: op.t,
          createdBy: op.a,
          nameTs: [op.t, op.a],
          deleted: false
        })
        break
      }
      case 'channel.rename': {
        const ch = g.channels.get(d.id)
        const name = str(d.name, 48).trim()
        if (ch && name && later(op.t, op.a, ...ch.nameTs)) { ch.name = name; ch.nameTs = [op.t, op.a] }
        break
      }
      case 'channel.delete': {
        const ch = g.channels.get(d.id)
        if (ch) ch.deleted = true
        break
      }
      case 'profile': {
        const m = this._member(g, op.a, op.t)
        if (op.t >= m.profileTs) {
          m.profileTs = op.t
          m.name = str(d.name, 32).trim()
          if (/^#[0-9a-f]{6}$/i.test(d.color || '')) m.color = d.color
          m.avatar = isAvatarUrl(d.avatar) ? d.avatar : null
        }
        break
      }
      case 'msg': {
        const id = str(d.id, 32)
        const ch = str(d.ch, 32)
        if (!id || !ch || g.msgById.has(id)) break
        const att = Array.isArray(d.att)
          ? d.att.slice(0, 10).filter(a => a && /^[0-9a-f]{64}$/.test(a.h)).map(a => ({
            h: a.h, s: Number(a.s) || 0, n: str(a.n, 200) || 'file', m: str(a.m, 100), w: Number(a.w) || 0, hh: Number(a.hh) || 0
          }))
          : []
        const msg = {
          id, ch, a: op.a, t: op.t, s: op.s,
          text: str(d.text, MAX_TEXT),
          att,
          re: str(d.re, 32) || null,
          edited: 0,
          deleted: false,
          reactions: new Map()
        }
        g.msgById.set(id, msg)
        let list = g.messages.get(ch)
        if (!list) { list = []; g.messages.set(ch, list) }
        insertSorted(list, msg)
        if (op.t > g.lastMsgTs) g.lastMsgTs = op.t
        const pending = g.pendingReactions.get(id)
        if (pending) { g.pendingReactions.delete(id); for (const p of pending) this._react(msg, p) }
        const typers = g.typing.get(ch)
        if (typers) typers.delete(op.a)
        break
      }
      case 'msg.edit': {
        const m = g.msgById.get(d.id)
        if (m && m.a === op.a && op.t >= m.edited) { m.text = str(d.text, MAX_TEXT); m.edited = op.t; m._md = null }
        break
      }
      case 'msg.delete': {
        const m = g.msgById.get(d.id)
        if (m && m.a === op.a && !m.deleted) {
          m.deleted = true
          const list = g.messages.get(m.ch)
          const i = list ? list.indexOf(m) : -1
          if (i >= 0) list.splice(i, 1)
        }
        break
      }
      case 'react': {
        const m = g.msgById.get(d.id)
        if (!m) {
          const list = g.pendingReactions.get(d.id) || []
          list.push(op)
          g.pendingReactions.set(d.id, list)
        } else {
          this._react(m, op)
        }
        break
      }
    }
  }

  _react (m, op) {
    const e = str(op.d.e, 16)
    if (!e) return
    let byKey = m.reactions.get(e)
    if (!byKey) { byKey = new Map(); m.reactions.set(e, byKey) }
    const prev = byKey.get(op.a)
    if (!prev || op.t >= prev.t) byKey.set(op.a, { on: !!op.d.on, t: op.t })
  }

  // ---- presence / ephemeral ----

  peerJoin (gid, key, info) {
    const g = this.groups.get(gid)
    if (!g) return
    g.online.set(key, info || { key })
    this.emit()
  }

  peerLeave (gid, key) {
    const g = this.groups.get(gid)
    if (!g) return
    g.online.delete(key)
    g.voice.delete(key)
    for (const t of g.typing.values()) t.delete(key)
    this.emit()
  }

  peerUpdate (info) {
    for (const g of this.groups.values()) if (g.online.has(info.key)) g.online.set(info.key, info)
    this.emit()
  }

  setVoiceState (gid, key, st) {
    const g = this.groups.get(gid)
    if (!g) return
    if (!st.ch) g.voice.delete(key)
    else g.voice.set(key, st)
    this.emit()
  }

  setTyping (gid, ch, key) {
    const g = this.groups.get(gid)
    if (!g || typeof ch !== 'string') return
    let t = g.typing.get(ch)
    if (!t) { t = new Map(); g.typing.set(ch, t) }
    t.set(key, Date.now() + 6000)
    this.emit()
  }

  _expireTyping () {
    const now = Date.now()
    let changed = false
    for (const g of this.groups.values()) {
      for (const t of g.typing.values()) {
        for (const [k, exp] of t) if (exp < now) { t.delete(k); changed = true }
      }
    }
    if (changed) this.emit()
  }

  // ---- helpers for views ----

  memberName (g, key) {
    if (key === this.me?.key && this.me.name) return this.me.name
    const m = g?.members.get(key)
    if (m && m.name) return m.name
    if (g?.dm === key && g.nameHint) return g.nameHint
    return this.knownName(key) || 'Friend ' + key.slice(0, 4)
  }

  // The newest profile anyone has for this key, in any group or private chat
  knownProfile (key) {
    let best = null
    for (const g of this.groups.values()) {
      const m = g.members.get(key)
      if (m && m.name && (!best || m.profileTs > best.profileTs)) best = m
    }
    return best
  }

  knownName (key) {
    const p = this.knownProfile(key)
    if (p) return p.name
    const req = this.friends.incoming.find(r => r.key === key) || this.friends.outgoing.find(r => r.key === key)
    if (req?.name) return req.name
    for (const g of this.groups.values()) if (g.dm === key && g.nameHint) return g.nameHint
    return ''
  }

  // Members of a group, without people who were removed
  membersOf (g) { return [...g.members.values()].filter(m => !g.removed.has(m.key)) }

  memberAvatar (g, key) {
    if (key === this.me?.key) return this.me.avatar || null
    const m = g?.members.get(key)
    return (m?.name ? m.avatar : this.knownProfile(key)?.avatar) || null
  }

  memberColor (g, key) {
    if (key === this.me?.key) return this.me.color
    const m = g?.members.get(key)
    return (m?.name ? m.color : this.knownProfile(key)?.color) || '#8b93a1'
  }

  groupName (g) { return g.dm ? this.memberName(g, g.dm) : g.name || g.nameHint }

  channelsOf (g, kind) {
    return [...g.channels.values()]
      .filter(c => !c.deleted && (!kind || c.kind === kind))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  }

  currentGroup () {
    if (this.ui.gid === HOME) return null
    let g = this.groups.get(this.ui.gid)
    if (!g) {
      g = this.groupsList()[0] || null
      this.ui.gid = g ? g.id : this.groups.size || this.friends.incoming.length ? HOME : null
    }
    return g
  }

  openHome () {
    this.ui.stage = null
    this.selectGroup(HOME)
  }

  currentChannel (g) {
    if (!g) return null
    const id = this.ui.chByGroup[g.id]
    const ch = g.channels.get(id)
    if (ch && !ch.deleted) return ch
    return this.channelsOf(g, 'text')[0] || null
  }

  selectGroup (gid) {
    this.ui.gid = gid
    this.ui.replyTo = null
    this.ui.editing = null
    try { localStorage.setItem('od.gid', gid) } catch {}
    this.emit()
  }

  selectChannel (gid, chId) {
    this.ui.chByGroup[gid] = chId
    this.ui.replyTo = null
    this.ui.editing = null
    try { localStorage.setItem('od.chByGroup', JSON.stringify(this.ui.chByGroup)) } catch {}
    this.emit()
  }

  markRead (gid, chId) {
    const g = this.groups.get(gid)
    const list = g?.messages.get(chId)
    const last = list && list.length ? list[list.length - 1].t : 0
    const k = gid + ':' + chId
    if ((this.lastRead[k] || 0) >= last) return
    this.lastRead[k] = last
    try { localStorage.setItem('od.lastRead', JSON.stringify(this.lastRead)) } catch {}
    this.emit()
  }

  unread (g, chId) {
    const list = g.messages.get(chId)
    if (!list || !list.length) return { count: 0, mentions: 0 }
    const since = this.lastRead[g.id + ':' + chId] || g.joinedAt
    let count = 0
    let mentions = 0
    for (let i = list.length - 1; i >= 0 && list[i].t > since; i--) {
      if (list[i].a === this.me.key) continue
      count++
      if (this.mentionsMe(list[i].text)) mentions++
    }
    return { count, mentions }
  }

  groupUnread (g) {
    let count = 0
    let mentions = 0
    for (const ch of this.channelsOf(g, 'text')) {
      const u = this.unread(g, ch.id)
      count += u.count
      mentions += u.mentions
    }
    return { count, mentions }
  }

  mentionsMe (text) {
    const name = this.me?.name
    if (!name || !text) return false
    return text.toLowerCase().includes('@' + name.toLowerCase()) || /@(everyone|here)\b/.test(text)
  }

  toast (text, kind = 'info') {
    const t = { id: Math.random(), text, kind }
    this.ui.toasts = [...this.ui.toasts, t]
    this.emit()
    setTimeout(() => { this.ui.toasts = this.ui.toasts.filter(x => x !== t); this.emit() }, kind === 'error' ? 7000 : 3500)
  }

  openModal (name, props = {}) { this.ui.modal = { name, props }; this.emit() }
  closeModal () { this.ui.modal = null; this.emit() }
}

function cmp (a, b) {
  return a.t - b.t || (a.a < b.a ? -1 : a.a > b.a ? 1 : a.s - b.s)
}

function insertSorted (list, msg) {
  let lo = 0
  let hi = list.length
  if (!hi || cmp(list[hi - 1], msg) <= 0) { list.push(msg); return }
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmp(list[mid], msg) <= 0) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, msg)
}
