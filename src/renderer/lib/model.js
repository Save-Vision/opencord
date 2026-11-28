// Derived application state. Every peer replays the same set of signed ops in a
// deterministic way, so everyone converges on identical channels/messages/profiles.

import { cleanGameInfo, deriveChess } from './games.js'
import { derivePoker } from './poker.js'
import { TextDoc } from './textcrdt.js'
import { cleanApps } from './apps.js'
import { CALL_ID, newCall, callStatus } from './calls.js'

const MAX_TEXT = 4000
const later = (t1, a1, t2, a2) => t1 > t2 || (t1 === t2 && a1 > a2)
// Field-by-field "newest edit wins" (events, tasks, folders, where a channel sits)
function setFields (x, fields, op) {
  for (const [f, v] of Object.entries(fields)) {
    const ts = x.ts[f]
    if (!ts || later(op.t, op.a, ts[0], ts[1])) { x[f] = v; x.ts[f] = [op.t, op.a] }
  }
}
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

// ---- planner (calendar events and tasks) ----
// Both are edited field by field: each field keeps the value of its newest edit, so two
// friends changing different things at once both win.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const TASK_STATUS = ['todo', 'doing', 'done']
export const RSVP = ['yes', 'maybe', 'no']

const pad2 = (n) => String(n).padStart(2, '0')
// 'YYYY-MM-DD' of a local date
export const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
export function parseDay (s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, m - 1, d)
}
// When an event starts / ends, in ms. All-day events last the whole local day.
export const eventStart = (e) => (e.allDay ? parseDay(e.day).getTime() : e.start)
export const eventEnd = (e) => (e.allDay ? parseDay(e.day).getTime() + 864e5 : e.start + (e.dur || 60) * 60000)
export const eventDay = (e) => (e.allDay ? e.day : dayKey(new Date(e.start)))

function eventFields (d) {
  const o = {}
  if ('title' in d) o.title = str(d.title, 200).trim()
  if ('desc' in d) o.desc = str(d.desc, 4000)
  if ('loc' in d) o.loc = str(d.loc, 200)
  if ('day' in d && DAY_RE.test(d.day || '')) o.day = d.day // local calendar day
  if ('allDay' in d) o.allDay = !!d.allDay
  if ('dur' in d) o.dur = Number.isInteger(d.dur) && d.dur > 0 && d.dur <= 14 * 1440 ? d.dur : 60 // minutes
  // a timed event's start, as an absolute time (so friends in other time zones agree)
  if ('start' in d) o.start = Number.isFinite(d.start) ? d.start : null
  if ('remind' in d) o.remind = Number.isInteger(d.remind) && d.remind >= 0 && d.remind <= 40320 ? d.remind : null
  return o
}

function taskFields (d) {
  const o = {}
  if ('title' in d) o.title = str(d.title, 200).trim()
  if ('desc' in d) o.desc = str(d.desc, 4000)
  if ('status' in d) o.status = TASK_STATUS.includes(d.status) ? d.status : 'todo'
  if ('assignee' in d) o.assignee = isKey(d.assignee) ? d.assignee : null
  if ('due' in d) o.due = DAY_RE.test(d.due || '') ? d.due : null
  if ('order' in d && Number.isFinite(d.order)) o.order = d.order
  if ('checklist' in d) {
    o.checklist = Array.isArray(d.checklist)
      ? d.checklist.slice(0, 50).filter(i => i && typeof i === 'object').map((i, n) => ({ id: str(i.id, 16) || String(n), text: str(i.text, 300), done: !!i.done }))
      : []
  }
  return o
}

// ---- folders ----
// Folders hold channels and other folders (up to MAX_FOLDER_DEPTH deep). Where a channel or
// folder sits (folder + order) is its own last-writer-wins field, so moving things around never
// touches the channel itself, and 0.4 apps simply keep showing a flat list.
export const MAX_FOLDER_DEPTH = 3

function folderFields (d) {
  const o = {}
  if ('name' in d) { const n = str(d.name, 48).trim(); if (n) o.name = n }
  if ('parent' in d) o.parent = str(d.parent, 32) || null
  if ('order' in d && Number.isFinite(d.order)) o.order = d.order
  return o
}

function placeFields (d) {
  const o = {}
  if ('folder' in d) o.folder = str(d.folder, 32) || null
  if ('order' in d && Number.isFinite(d.order)) o.order = d.order
  return o
}

// ---- polls ----
// msg { poll: { q, opts: [{ id, t }], multi, ends } }; poll.vote { id, v: [option ids] } (each
// voter's newest vote counts); poll.close { id } by the author ends it early.
function cleanPoll (p) {
  if (!p || typeof p !== 'object') return null
  const q = str(p.q, 300).trim()
  const seen = new Set()
  const opts = (Array.isArray(p.opts) ? p.opts : []).slice(0, 10)
    .map(o => ({ id: str(o?.id, 8), t: str(o?.t, 100).trim() }))
    .filter(o => o.id && o.t && !seen.has(o.id) && seen.add(o.id))
  if (!q || opts.length < 2) return null
  return { q, opts, multi: !!p.multi, ends: Number.isFinite(p.ends) && p.ends > 0 ? p.ends : null }
}

const hexList = (v, n) => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) ? v : null
function cleanKeys (k) {
  if (!k || typeof k !== 'object') return null
  const out = {}
  for (const [i, v] of Object.entries(k).slice(0, 52)) if (/^\d{1,2}$/.test(i) && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out[i] = v
  return out
}
const POKER_OPS = new Set(['sit', 'leave', 'away', 'rebuy', 'start', 'end', 'deal', 'shuf', 'lock', 'keys', 'act', 'time', 'void'])

// ---- soundboard ----
// sound.add { id, name, emoji, h, s, m, dur } (a short clip, shared by the whole group);
// sound.delete { id } by whoever added it, or an admin
export const MAX_SOUNDS = 48
export const MAX_SOUND_BYTES = 1024 * 1024
export const MAX_SOUND_MS = 7000

const newEvent = (id) => ({ id, title: '', desc: '', loc: '', day: null, allDay: false, dur: 60, start: null, remind: 15, createdAt: Infinity, createdBy: null, ts: {}, rsvp: new Map(), deleted: false })
const newTask = (id) => ({ id, title: '', desc: '', status: 'todo', assignee: null, due: null, order: null, checklist: [], createdAt: Infinity, createdBy: null, ts: {}, deleted: false })

function setMembership (g, m) {
  if (!m) return
  g.owner = isKey(m.owner) ? m.owner : null
  g.admins = new Set((m.admins || []).filter(isKey))
  g.removed = new Set((m.removed || []).filter(isKey))
  g.kickedMe = !!m.kickedMe
  g.restoring = !!m.restoring
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
    threads: new Map(), // root msg id -> replies, oldest first
    events: new Map(),
    tasks: new Map(),
    invites: new Map(), // id -> { id, exp, by, t, used, revoked }
    settingsOps: [], // group.settings ops (who may change them is checked when read)
    folders: new Map(), // id -> { id, name, parent, order, ... }
    placement: new Map(), // channel id -> { folder, order, ts }
    treeV: 0, // bumped when channels or folders change (the sidebar tree is cached on it)
    games: new Map(), // msg id -> { info, by, ops, v }
    polls: new Map(), // msg id -> { votes: Map(key -> [{ v, t, s }]), closes: [{ a, t }] }
    sounds: new Map(), // id -> soundboard clip
    docs: new Map(), // id -> focus document (views/focus.js)
    calls: new Map(), // id -> a private call: who called, answered, declined, when it ended (lib/calls.js)
    restoring: false, // restored from a backup and still catching up (see main/store.js)
    claudeDrafts: new Map(), // msg id -> an answer Claude is still writing (live, not stored)
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
    this.friends = { code: '', incoming: [], outgoing: [], links: [] }
    this.joins = [] // one-time invites we're waiting to be let in with
    this.statuses = new Map() // key -> 'online' | 'away' | 'invisible', as friends announced it
    this.compat = [] // apps that can't sync with us because one side is too old (main/network.js)
    this.idle = false // no input for a while (auto away)
    this.ui = {
      gid: null,
      chByGroup: {},
      modal: null,
      toasts: [],
      focused: document.hasFocus(),
      replyTo: null,
      editing: null,
      thread: null, // { gid, id } open thread panel
      planner: null, // { gid, tab: 'calendar' | 'tasks' }
      games: null, // { gid, id }: the games list (id null) or one board
      docs: null // { gid, id }: the focus documents list (id null) or one document in focus mode
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
    this.friends = { code: f?.code || '', incoming: f?.incoming || [], outgoing: f?.outgoing || [], links: f?.links || [] }
    this.emit()
  }

  setJoins (list) {
    this.joins = Array.isArray(list) ? list : []
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
  isMod (g, key) { return !!g && (key === g.owner || g.admins.has(key)) }

  // ---- group settings & invites (same rules as main/store.js) ----

  // Each setting: the newest value set by the owner or an admin
  groupSettings (g) {
    const best = {}
    for (const op of g.settingsOps) {
      if (!this.isMod(g, op.a)) continue
      for (const f of Object.keys(op.d)) if (!best[f] || later(op.t, op.a, best[f].t, best[f].a)) best[f] = op
    }
    return {
      invites: best.invites?.d.invites === 'admins' ? 'admins' : 'all',
      claude: best.claude?.d.claude === 'off' ? 'off' : 'on',
      apps: best.apps ? best.apps.d.apps : [] // lib/apps.js: a group starts without any
    }
  }

  // Whether an app (lib/apps.js) is added to this group. Private chats have them all.
  appOn (g, id) { return !!g && (!!g.dm || this.groupSettings(g).apps.includes(id)) }

  // A group.settings op always carries every setting, so apps that only know some of them
  // (0.4 reads the whole op as "the invite setting") still agree.
  settingsWith (g, patch) { return { ...this.groupSettings(g), ...patch } }

  claudeAllowed (g) { return !!g && (g.dm || this.groupSettings(g).claude !== 'off') }

  canInvite (g) {
    return !!g && !g.dm && !g.kickedMe && (this.groupSettings(g).invites !== 'admins' || this.isMod(g, this.me.key))
  }

  // Unused invites, newest first
  activeInvites (g) {
    const now = Date.now()
    const adminsOnly = this.groupSettings(g).invites === 'admins'
    return [...g.invites.values()]
      .filter(i => i.t && !i.used && !i.revoked && (!i.exp || i.exp > now) && (!adminsOnly || this.isMod(g, i.by)))
      .sort((a, b) => b.t - a.t)
  }

  // ---- threads ----

  threadOf (g, id) { return g.threads.get(id) || [] }

  threadInfo (g, id) {
    const list = g.threads.get(id)
    if (!list || !list.length) return null
    const people = []
    for (let i = list.length - 1; i >= 0 && people.length < 4; i--) if (!people.includes(list[i].a)) people.push(list[i].a)
    return { count: list.length, last: list[list.length - 1].t, people }
  }

  // You follow a thread you started or replied to
  follows (g, id) {
    const root = g.msgById.get(id)
    if (root && root.a === this.me.key) return true
    return this.threadOf(g, id).some(m => m.a === this.me.key)
  }

  _threadSince (g, id) {
    let since = this.lastRead[g.id + ':t:' + id] || g.joinedAt
    for (const m of this.threadOf(g, id)) if (m.a === this.me.key && m.t > since) since = m.t
    return since
  }

  threadUnread (g, id) {
    const list = this.threadOf(g, id)
    const since = this._threadSince(g, id)
    let n = 0
    for (let i = list.length - 1; i >= 0 && list[i].t > since; i--) if (list[i].a !== this.me.key) n++
    return n
  }

  markThreadRead (gid, id) {
    const g = this.groups.get(gid)
    const list = g && this.threadOf(g, id)
    const last = list && list.length ? list[list.length - 1].t : 0
    const k = gid + ':t:' + id
    if (!last || (this.lastRead[k] || 0) >= last) return
    this.lastRead[k] = last
    try { localStorage.setItem('od.lastRead', JSON.stringify(this.lastRead)) } catch {}
    this.emit()
  }

  openThread (gid, id) {
    this.ui.thread = { gid, id }
    if (this.ui.search?.gid === gid) this.ui.search = null
    this.emit()
  }

  // The search panel of the current group (views/search.js); n refocuses the box
  openSearch (q = '') {
    const g = this.currentGroup()
    if (!g) return
    this.ui.search = { gid: g.id, q, n: (this.ui.search?.n || 0) + 1 }
    this.ui.thread = null
    this.ui.planner = null
    this.emit()
  }

  closeThread () {
    this.ui.thread = null
    this.emit()
  }

  // ---- planner ----

  eventsOf (g) {
    return [...g.events.values()].filter(e => !e.deleted && e.title && (e.allDay ? !!e.day : e.start != null))
  }

  tasksOf (g) {
    return [...g.tasks.values()].filter(t => !t.deleted && t.title)
      .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt))
  }

  openPlanner (gid, tab) {
    this.ui.planner = { gid, tab }
    this.ui.games = null
    this.ui.docs = null
    this.ui.stage = null
    this.ui.thread = null
    this.selectGroup(gid)
  }

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
    if (op.k === 'x') return // a stub: the op it replaced is no longer needed (see store.js)
    this._member(g, op.a, op.t)
    switch (op.k) {
      case 'group.settings': {
        const s = {}
        if (d.invites === 'admins' || d.invites === 'all') s.invites = d.invites
        if (d.claude === 'on' || d.claude === 'off') s.claude = d.claude
        const apps = cleanApps(d.apps)
        if (apps) s.apps = apps
        if (Object.keys(s).length) g.settingsOps.push({ a: op.a, t: op.t, d: s })
        break
      }
      case 'folder.create':
      case 'folder.set': {
        const id = str(d.id, 32)
        if (!id || g.dm) break
        let f = g.folders.get(id)
        if (!f) { f = { id, name: 'Folder', parent: null, order: null, createdAt: Infinity, createdBy: null, ts: {}, deleted: false }; g.folders.set(id, f) }
        if (op.k === 'folder.create' && op.t < f.createdAt) { f.createdAt = op.t; f.createdBy = op.a }
        setFields(f, folderFields(d), op)
        g.treeV++
        break
      }
      case 'folder.delete': {
        const id = str(d.id, 32)
        if (!id || g.dm) break
        if (!g.folders.has(id)) g.folders.set(id, { id, name: 'Folder', parent: null, order: null, createdAt: Infinity, createdBy: null, ts: {}, deleted: false })
        g.folders.get(id).deleted = true
        g.treeV++
        break
      }
      case 'channel.move': {
        const id = str(d.id, 32)
        if (!id || g.dm) break
        setFields(this._placement(g, id), placeFields(d), op)
        g.treeV++
        break
      }
      case 'poll.vote': {
        const id = str(d.id, 32)
        if (!id || !Array.isArray(d.v)) break
        const p = this._poll(g, id)
        // every vote is kept (a few), so one cast after the poll ended doesn't erase the last valid one
        const list = p.votes.get(op.a) || []
        list.push({ v: d.v.slice(0, 10).map(x => str(x, 8)).filter(Boolean), t: op.t, s: op.s })
        list.sort((x, y) => x.t - y.t || x.s - y.s)
        if (list.length > 20) list.shift()
        p.votes.set(op.a, list)
        break
      }
      case 'poll.close': {
        const id = str(d.id, 32)
        if (!id) break
        const p = this._poll(g, id)
        p.closes.push({ a: op.a, t: op.t })
        break
      }
      case 'sound.add': {
        const id = str(d.id, 32)
        if (!id || g.sounds.has(id) || !/^[0-9a-f]{64}$/.test(d.h || '')) break
        const s = Number(d.s) || 0
        if (s <= 0 || s > MAX_SOUND_BYTES || !/^audio\//.test(d.m || '')) break
        g.sounds.set(id, { id, name: str(d.name, 32).trim() || 'Sound', emoji: str(d.emoji, 16), h: d.h, s, m: str(d.m, 60), dur: Math.min(MAX_SOUND_MS, Math.max(0, Number(d.dur) || 0)), by: op.a, t: op.t, deletedBy: [] })
        break
      }
      case 'sound.delete': {
        const sd = g.sounds.get(str(d.id, 32))
        if (sd) sd.deletedBy.push(op.a)
        else if (str(d.id, 32)) g.sounds.set(str(d.id, 32), { id: str(d.id, 32), pendingDelete: true, deletedBy: [op.a] })
        break
      }
      case 'poker.sit':
      case 'poker.leave':
      case 'poker.away':
      case 'poker.rebuy':
      case 'poker.start':
      case 'poker.end':
      case 'poker.deal':
      case 'poker.shuf':
      case 'poker.lock':
      case 'poker.keys':
      case 'poker.act':
      case 'poker.time':
      case 'poker.void': {
        const id = str(d.id, 32)
        const k = op.k.slice(6)
        if (!id || !POKER_OPS.has(k)) break
        const gm = this._game(g, id)
        gm.ops.push({
          k, a: op.a, s: op.s, t: op.t,
          recv: Date.now(), // when this app learned of it: timers run on local time only
          h: Number.isInteger(d.h) ? d.h : null,
          n: Number.isInteger(d.n) ? d.n : -1,
          act: str(d.a, 8),
          to: Number.isInteger(d.to) ? d.to : null,
          on: k === 'away' ? !!d.on : d.on !== false,
          players: Array.isArray(d.players) ? d.players.filter(isKey).slice(0, 8) : null,
          deck: hexList(d.deck, 52),
          commits: hexList(d.commits, 52),
          keys: cleanKeys(d.k)
        })
        gm.last = Math.max(gm.last || 0, op.t)
        gm.v++
        break
      }
      case 'call.start':
      case 'call.join':
      case 'call.decline':
      case 'call.end': {
        if (!g.dm || typeof d.id !== 'string' || !CALL_ID.test(d.id)) break
        let c = g.calls.get(d.id)
        if (!c) { c = newCall(d.id); g.calls.set(d.id, c) }
        const k = op.k.slice(5)
        if (k === 'start') {
          if (!c.by || op.t < c.t) { c.by = op.a; c.t = op.t }
          if (op.t > g.lastMsgTs) g.lastMsgTs = op.t
        } else if (k === 'join') {
          if (!c.joins.has(op.a) || op.t < c.joins.get(op.a)) c.joins.set(op.a, op.t)
        } else if (k === 'decline') {
          if (!c.declined.has(op.a)) c.declined.set(op.a, op.t)
        } else if (op.t > c.end) c.end = op.t
        g.callsV = (g.callsV || 0) + 1
        break
      }
      case 'game.join':
      case 'game.decline':
      case 'game.move':
      case 'game.resign':
      case 'game.draw':
      case 'game.flag':
      case 'game.abort': {
        const id = str(d.id, 32)
        if (!id) break
        const gm = this._game(g, id)
        gm.ops.push({
          k: op.k.slice(5), a: op.a, s: op.s, t: op.t,
          n: Number.isInteger(d.n) ? d.n : -1,
          m: str(d.m, 5),
          left: Number.isFinite(d.left) ? d.left : null,
          no: !!d.no,
          recv: Date.now() // when this app learned of it: clocks run on local time only
        })
        gm.last = Math.max(gm.last || 0, op.t)
        gm.v++
        break
      }
      case 'invite.create': {
        const id = str(d.id, 32)
        if (!id) break
        const inv = g.invites.get(id) || { id, used: null, revoked: false }
        if (!inv.t) Object.assign(inv, { exp: Number(d.exp) || 0, by: op.a, t: op.t })
        g.invites.set(id, inv)
        break
      }
      case 'invite.used':
      case 'invite.revoke': {
        const id = str(d.id, 32)
        if (!id) break
        const inv = g.invites.get(id) || { id, used: null, revoked: false }
        if (op.k === 'invite.used' && isKey(d.key) && (!inv.used || later(inv.used.t, inv.used.by, op.t, op.a))) inv.used = { key: d.key, by: op.a, t: op.t }
        if (op.k === 'invite.revoke') inv.revokedBy = [...(inv.revokedBy || []), op.a]
        inv.revoked = (inv.revokedBy || []).some(a => a === inv.by || this.isMod(g, a))
        g.invites.set(id, inv)
        break
      }
      case 'doc.set': {
        const id = str(d.id, 32)
        if (!id) break
        const doc = this._doc(g, id)
        if (op.t < doc.createdAt) { doc.createdAt = op.t; doc.createdBy = op.a }
        const name = str(d.name, 80).trim()
        if (name && later(op.t, op.a, ...doc.nameTs)) { doc.name = name; doc.nameTs = [op.t, op.a] }
        break
      }
      case 'doc.edit': {
        const id = str(d.id, 32)
        if (!id) break
        const doc = this._doc(g, id)
        doc.text.applyOp(op.a, d)
        if (op.t > doc.editedAt) { doc.editedAt = op.t; doc.editedBy = op.a }
        doc.editors.add(op.a)
        break
      }
      case 'doc.delete': {
        const id = str(d.id, 32)
        if (id) this._doc(g, id).deletes.push(op.a)
        break
      }
      case 'event.set':
      case 'task.set': {
        const id = str(d.id, 32)
        if (!id) break
        const map = op.k === 'event.set' ? g.events : g.tasks
        let x = map.get(id)
        if (!x) { x = op.k === 'event.set' ? newEvent(id) : newTask(id); map.set(id, x) }
        if (op.t < x.createdAt) { x.createdAt = op.t; x.createdBy = op.a }
        for (const [f, v] of Object.entries(op.k === 'event.set' ? eventFields(d) : taskFields(d))) {
          const ts = x.ts[f]
          if (!ts || later(op.t, op.a, ts[0], ts[1])) { x[f] = v; x.ts[f] = [op.t, op.a] }
        }
        break
      }
      case 'event.delete':
      case 'task.delete': {
        const id = str(d.id, 32)
        if (!id) break
        const map = op.k === 'event.delete' ? g.events : g.tasks
        if (!map.has(id)) map.set(id, op.k === 'event.delete' ? newEvent(id) : newTask(id))
        map.get(id).deleted = true
        break
      }
      case 'event.rsvp': {
        const id = str(d.id, 32)
        if (!id) break
        if (!g.events.has(id)) g.events.set(id, newEvent(id))
        const e = g.events.get(id)
        const prev = e.rsvp.get(op.a)
        if (!prev || op.t >= prev.t) e.rsvp.set(op.a, { v: RSVP.includes(d.going) ? d.going : null, t: op.t })
        break
      }
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
        setFields(this._placement(g, id), placeFields(d), op)
        g.treeV++
        break
      }
      case 'channel.rename': {
        const ch = g.channels.get(d.id)
        const name = str(d.name, 48).trim()
        if (ch && name && later(op.t, op.a, ...ch.nameTs)) { ch.name = name; ch.nameTs = [op.t, op.a] }
        g.treeV++
        break
      }
      case 'channel.delete': {
        const ch = g.channels.get(d.id)
        if (ch) ch.deleted = true
        g.treeV++
        break
      }
      case 'profile': {
        const m = this._member(g, op.a, op.t)
        if (op.t >= m.profileTs) {
          m.profileTs = op.t
          m.name = str(d.name, 32).trim()
          if (/^#[0-9a-f]{6}$/i.test(d.color || '')) m.color = d.color
          m.avatar = isAvatarUrl(d.avatar) ? d.avatar : null
          m.claude = !!d.claude // lets Claude read their messages when someone else asks
        }
        break
      }
      case 'msg': {
        const id = str(d.id, 32)
        const ch = str(d.ch, 32)
        if (!id || !ch) break
        const existing = g.msgById.get(id)
        if (existing) {
          // A tombstone from someone else's "delete" can't hide a message they didn't write
          if (!(existing.tomb && existing.a !== op.a)) break
          this._unlist(g, existing)
        }
        const att = Array.isArray(d.att)
          ? d.att.slice(0, 10).filter(a => a && /^[0-9a-f]{64}$/.test(a.h)).map(a => ({
            h: a.h, s: Number(a.s) || 0, n: str(a.n, 200) || 'file', m: str(a.m, 100), w: Number(a.w) || 0, hh: Number(a.hh) || 0
          }))
          : []
        const th = str(d.th, 32) || null
        const game = !th && cleanGameInfo(d.game)
        const poll = !th && !game && cleanPoll(d.poll)
        const msg = {
          id, ch, a: op.a, t: op.t, s: op.s,
          text: str(d.text, MAX_TEXT),
          att,
          re: str(d.re, 32) || null,
          th, // a reply in the thread of this message
          also: !!(th && d.also), // ...also shown in the channel
          // Claude's answer: posted (and signed) by the app of whoever asked, with their API key
          bot: d.bot && typeof d.bot === 'object' && d.bot.n === 'claude' ? { model: str(d.bot.model, 40) } : null,
          game: !!game, // the card of a chess game or poker table (see lib/games.js, lib/poker.js)
          ping: game ? game.opp || null : null, // someone challenged to a game
          poll: poll || null,
          edited: 0,
          deleted: false,
          reactions: new Map()
        }
        g.msgById.set(id, msg)
        g.claudeDrafts.delete(id)
        if (game) {
          const gm = this._game(g, id)
          Object.assign(gm, { info: game, by: op.a, ch, t: op.t })
          gm.v++
        }
        if (th) {
          let tl = g.threads.get(th)
          if (!tl) { tl = []; g.threads.set(th, tl) }
          insertSorted(tl, msg)
          // a deleted message that gains replies shows as "deleted" so its thread stays reachable
          const root = g.msgById.get(th)
          if (root?.deleted) this._list(g, root)
        }
        if (!th || msg.also) this._list(g, msg)
        if (op.t > g.lastMsgTs) g.lastMsgTs = op.t
        const pending = g.pendingReactions.get(id)
        if (pending) { g.pendingReactions.delete(id); for (const p of pending) this._react(msg, p) }
        const typers = g.typing.get(ch)
        if (typers) typers.delete(op.a)
        break
      }
      case 'msg.edit': {
        const m = g.msgById.get(d.id)
        if (m && m.a === op.a && !m.deleted && op.t >= m.edited) { m.text = str(d.text, MAX_TEXT); m.edited = op.t; m._md = null }
        break
      }
      case 'msg.delete': {
        const id = str(d.id, 32)
        const m = g.msgById.get(id)
        if (m) {
          if (m.a !== op.a || m.deleted) break
          m.deleted = true
          m.text = ''
          m.att = []
          m._md = null
          if (m.th) {
            const tl = g.threads.get(m.th)
            const i = tl ? tl.indexOf(m) : -1
            if (i >= 0) tl.splice(i, 1)
          }
          if (!g.threads.get(m.id)?.length) this._unlist(g, m)
        } else if (id) {
          // The message itself is gone from storage (only a stub is left, see store.js): remember
          // where it was, so replies in its thread still have a home
          const ch = str(d.ch, 32)
          const at = Number(d.at)
          if (!ch || !Number.isFinite(at)) break
          const tomb = { id, ch, a: op.a, t: at, s: 0, text: '', att: [], re: null, th: null, also: false, edited: 0, deleted: true, tomb: true, reactions: new Map() }
          g.msgById.set(id, tomb)
          if (g.threads.get(id)?.length) this._list(g, tomb)
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

  _placement (g, id) {
    let p = g.placement.get(id)
    if (!p) { p = { folder: null, order: null, ts: {} }; g.placement.set(id, p) }
    return p
  }

  _game (g, id) {
    let gm = g.games.get(id)
    if (!gm) { gm = { id, info: null, by: null, ch: null, t: 0, last: 0, ops: [], v: 0, cacheV: -1, cache: null, cards: new Map(), mine: new Map() }; g.games.set(id, gm) }
    return gm
  }

  _poll (g, id) {
    let p = g.polls.get(id)
    if (!p) { p = { votes: new Map(), closes: [] }; g.polls.set(id, p) }
    return p
  }

  // ---- polls ----

  // { counts, total, voters: Map(option -> keys), mine, ended, endsAt }
  pollResults (g, m) {
    const poll = m.poll
    const p = g.polls.get(m.id) || { votes: new Map(), closes: [] }
    const closedBy = p.closes.filter(c => c.a === m.a).sort((a, b) => a.t - b.t)[0]
    const endsAt = Math.min(poll.ends || Infinity, closedBy ? closedBy.t : Infinity)
    const ids = new Set(poll.opts.map(o => o.id))
    const voters = new Map(poll.opts.map(o => [o.id, []]))
    let total = 0
    let mine = []
    for (const [key, list] of p.votes) {
      let vote = null
      for (const x of list) if (x.t <= endsAt) vote = x
      if (!vote || g.removed.has(key)) continue
      let v = [...new Set(vote.v)].filter(x => ids.has(x))
      if (!poll.multi) v = v.slice(0, 1)
      if (key === this.me.key) mine = v
      if (!v.length) continue
      total++
      for (const x of v) voters.get(x).push(key)
    }
    return { total, voters, mine, ended: Date.now() >= endsAt, endsAt: Number.isFinite(endsAt) ? endsAt : null, closed: !!closedBy }
  }

  // ---- soundboard ----

  soundsOf (g) {
    return [...g.sounds.values()]
      .filter(s => !s.pendingDelete && !s.deletedBy.some(a => a === s.by || this.isMod(g, a)))
      .sort((a, b) => a.t - b.t)
      .slice(0, MAX_SOUNDS)
  }

  // ---- status (online / away / appear offline) ----

  // What I show friends right now
  myStatus () {
    const s = this.settings?.status
    if (s === 'invisible' || s === 'away') return s
    return this.idle ? 'away' : 'online'
  }

  setStatus (key, s) {
    if (!['online', 'away', 'invisible'].includes(s)) return
    if (this.statuses.get(key) === s) return
    this.statuses.set(key, s)
    this.emit()
  }

  // 'online' | 'away' | 'offline' for anyone in g (or anywhere, without g)
  presence (g, key) {
    if (key === this.me?.key) { const s = this.myStatus(); return s === 'invisible' ? 'offline' : s }
    const on = g ? g.online.has(key) : [...this.groups.values()].some(x => x.online.has(key))
    if (!on) return 'offline'
    const s = this.statuses.get(key)
    return s === 'invisible' ? 'offline' : s === 'away' ? 'away' : 'online'
  }

  // ---- folders & the channel tree ----

  // The folder something shows in: its folder, or the nearest one above it that still exists
  _liveFolder (g, id) {
    const seen = new Set()
    let f = id ? g.folders.get(id) : null
    while (f && f.deleted && !seen.has(f.id)) { seen.add(f.id); f = f.parent ? g.folders.get(f.parent) : null }
    return f && !f.deleted && f.createdBy ? f : null
  }

  // A folder's parent. If moves made at the same time put a folder inside itself (or deeper
  // than MAX_FOLDER_DEPTH), it goes to the top level; every app decides that the same way.
  folderParent (g, f) {
    const p = this._liveFolder(g, f.parent)
    const seen = new Set([f.id])
    let x = p
    let depth = 1
    while (x) {
      if (seen.has(x.id) || depth >= MAX_FOLDER_DEPTH) return null
      seen.add(x.id)
      x = this._liveFolder(g, x.parent)
      depth++
    }
    return p
  }

  // How deep a folder sits (0 = top level)
  folderDepth (g, f) {
    let n = 0
    for (let x = this.folderParent(g, f); x && n < MAX_FOLDER_DEPTH; x = this.folderParent(g, x)) n++
    return n
  }

  // Is `id` the folder f or inside it?
  inFolder (g, id, f) {
    for (let x = g.folders.get(id); x; x = this.folderParent(g, x)) if (x.id === f.id) return true
    return false
  }

  foldersOf (g) { return [...g.folders.values()].filter(f => !f.deleted && f.createdBy) }

  channelFolder (g, chId) { return this._liveFolder(g, g.placement.get(chId)?.folder) }

  sortKey (g, x) { return x.kind ? (g.placement.get(x.id)?.order ?? x.createdAt) : (x.order ?? x.createdAt) }

  // { text, voice, folders }: channels outside folders by kind, then folders with their
  // channels and sub-folders mixed in one order
  channelTree (g) {
    if (g._tree && g._tree.v === g.treeV) return g._tree
    const byOrder = (a, b) => this.sortKey(g, a) - this.sortKey(g, b) || (a.id < b.id ? -1 : 1)
    const nodes = new Map()
    for (const f of this.foldersOf(g)) nodes.set(f.id, { f, items: [] })
    const root = { text: [], voice: [], folders: [], v: g.treeV }
    for (const node of nodes.values()) {
      const p = this.folderParent(g, node.f)
      if (p) nodes.get(p.id).items.push({ node, key: node.f })
      else root.folders.push(node)
    }
    for (const c of g.channels.values()) {
      if (c.deleted) continue
      const f = g.dm ? null : this.channelFolder(g, c.id)
      if (f) nodes.get(f.id).items.push({ ch: c, key: c })
      else root[c.kind === 'voice' ? 'voice' : 'text'].push(c)
    }
    root.text.sort(byOrder)
    root.voice.sort(byOrder)
    root.folders.sort((a, b) => byOrder(a.f, b.f))
    for (const node of nodes.values()) node.items.sort((a, b) => byOrder(a.key, b.key))
    g._tree = root
    return root
  }

  // Channels in the order the sidebar shows them
  orderedChannels (g, kind) {
    const tree = this.channelTree(g)
    const out = [...tree.text, ...tree.voice]
    const walk = (node) => { for (const it of node.items) it.ch ? out.push(it.ch) : walk(it.node) }
    tree.folders.forEach(walk)
    return kind ? out.filter(c => c.kind === kind) : out
  }

  // ---- games ----

  gameState (g, id) {
    const gm = g.games.get(id)
    if (!gm) return null
    if (gm.cacheV !== gm.v) {
      gm.cache = gm.info?.kind === 'poker' ? derivePoker(gm, (h, j) => gm.cards.get(h + ':' + j)) : deriveChess(gm)
      gm.cacheV = gm.v
    }
    return gm.cache
  }

  // A poker card opened by the app (lib/pokerplay.js): public ones change the game, mine don't
  setPokerCard (g, id, h, j, card, mine = false) {
    const gm = g.games.get(id)
    if (!gm) return
    const map = mine ? gm.mine : gm.cards
    if (map.get(h + ':' + j) === card) return
    map.set(h + ':' + j, card)
    if (!mine) gm.v++
    this.emit()
  }

  // Games whose card still exists, newest activity first
  gamesOf (g) {
    const out = []
    for (const gm of g.games.values()) {
      const m = g.msgById.get(gm.id)
      if (!gm.info || !m || m.deleted) continue
      const st = this.gameState(g, gm.id)
      const last = Math.max(gm.t, gm.last || 0)
      out.push({ id: gm.id, gm, st, m, last })
    }
    return out.sort((a, b) => b.last - a.last)
  }

  // Waiting on me: my move, or a challenge to me
  isMyTurn (st) {
    const me = this.me.key
    if (st.kind === 'poker') return st.hand?.stage === 'bet' && st.hand.toAct === me
    if (st.status === 'open') return st.info.opp === me
    if (st.status !== 'active') return false
    return (st.pos.turn === 'w' ? st.white : st.black) === me
  }

  // ---- focus documents (views/focus.js, lib/textcrdt.js) ----

  _doc (g, id) {
    let doc = g.docs.get(id)
    if (!doc) {
      doc = { id, name: 'Untitled', nameTs: [-1, ''], createdAt: Infinity, createdBy: null, editedAt: 0, editedBy: null, editors: new Set(), deletes: [], text: new TextDoc() }
      g.docs.set(id, doc)
    }
    return doc
  }

  // A document is gone once its creator or an admin deleted it
  docDeleted (g, doc) {
    return doc.deletes.some(a => a === doc.createdBy || this.isMod(g, a))
  }

  docsOf (g) {
    return [...g.docs.values()].filter(d => d.createdBy && !this.docDeleted(g, d)).sort((a, b) => Math.max(b.editedAt, b.createdAt) - Math.max(a.editedAt, a.createdAt))
  }

  openDocs (gid, id = null) {
    this.ui.stage = null
    this.ui.planner = null
    this.ui.games = null
    this.ui.thread = null
    this.selectGroup(gid)
    this.ui.docs = { gid, id }
    this.emit()
  }

  // Who has a document open (live, not stored): 'doc' ephemeral messages, refreshed every few
  // seconds while open
  setDocPresence (gid, from, d) {
    if (!this.docPeers) this.docPeers = new Map()
    const k = gid + '/' + str(d.id, 32)
    if (!this.docPeers.has(k)) this.docPeers.set(k, new Map())
    const m = this.docPeers.get(k)
    if (d.here) m.set(from, { t: Date.now(), line: Number.isInteger(d.line) ? d.line : null, typing: !!d.typing })
    else m.delete(from)
    this.emit()
  }

  docPresence (gid, id) {
    const m = this.docPeers?.get(gid + '/' + id)
    if (!m) return []
    const now = Date.now()
    return [...m.entries()].filter(([k, v]) => now - v.t < 15000 && k !== this.me.key).map(([key, v]) => ({ key, ...v }))
  }

  myGameTurns (g) { return this.gamesOf(g).filter(x => this.isMyTurn(x.st)).length }

  openGames (gid) {
    this.ui.stage = null
    this.ui.planner = null
    this.ui.docs = null
    this.selectGroup(gid)
    this.ui.games = { gid, id: null }
    this.ui.thread = null
    this.emit()
  }

  openGame (gid, id) {
    this.ui.stage = null
    this.ui.planner = null
    this.ui.docs = null
    this.selectGroup(gid)
    this.ui.games = { gid, id }
    this.ui.thread = { gid, id } // the game's chat is the thread of its card
    this.emit()
  }

  // ---- Claude ----

  // Text Claude is still writing (sent live by the asker's app, see lib/claude.js)
  setClaudeDraft (gid, from, d) {
    const g = this.groups.get(gid)
    const id = str(d.id, 32)
    if (!g || !id || g.msgById.has(id)) return
    if (d.done) g.claudeDrafts.delete(id)
    else {
      // one person asks one question at a time; don't let anyone flood the chat with drafts
      const theirs = [...g.claudeDrafts.values()].filter(x => x.by === from && x.id !== id)
      for (const x of theirs.slice(0, Math.max(0, theirs.length - 1))) g.claudeDrafts.delete(x.id)
      g.claudeDrafts.set(id, { id, ch: str(d.ch, 32), th: str(d.th, 32) || null, text: str(d.text, MAX_TEXT * 2), by: from, re: str(d.re, 32) || null, t: Date.now(), status: str(d.status, 40) })
    }
    this.emit()
  }

  claudeDraftsIn (g, ch, th = null) {
    return [...g.claudeDrafts.values()].filter(x => x.ch === ch && (th ? x.th === th : !x.th))
  }

  _list (g, m) {
    let list = g.messages.get(m.ch)
    if (!list) { list = []; g.messages.set(m.ch, list) }
    if (!list.includes(m)) insertSorted(list, m)
  }

  _unlist (g, m) {
    const list = g.messages.get(m.ch)
    const i = list ? list.indexOf(m) : -1
    if (i >= 0) list.splice(i, 1)
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
    if (![...this.groups.values()].some(x => x.online.has(key))) this.statuses.delete(key)
    for (const [id, x] of g.claudeDrafts) if (x.by === key) g.claudeDrafts.delete(id)
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
      // an answer whose writer went quiet (their app crashed or lost the connection)
      for (const [id, x] of g.claudeDrafts) if (now - x.t > 90000) { g.claudeDrafts.delete(id); changed = true }
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
    if (this.ui.gid !== gid) this.ui.thread = null
    if (this.ui.planner && this.ui.planner.gid !== gid) this.ui.planner = null
    if (this.ui.games && this.ui.games.gid !== gid) this.ui.games = null
    if (this.ui.docs && this.ui.docs.gid !== gid) this.ui.docs = null
    this.ui.gid = gid
    this.ui.replyTo = null
    this.ui.editing = null
    try { localStorage.setItem('od.gid', gid) } catch {}
    this.emit()
  }

  selectChannel (gid, chId) {
    if (this.ui.chByGroup[gid] !== chId || this.ui.games) this.ui.thread = null
    this.ui.planner = null
    this.ui.games = null
    this.ui.docs = null
    this.ui.chByGroup[gid] = chId
    this.ui.replyTo = null
    this.ui.editing = null
    try { localStorage.setItem('od.chByGroup', JSON.stringify(this.ui.chByGroup)) } catch {}
    this.emit()
  }

  // ---- private calls (lib/calls.js) ----

  // The calls of a private chat, oldest first (only those whose start we know)
  callsOf (g) {
    if (!g?.dm || !g.calls.size) return []
    return [...g.calls.values()].filter(c => c.by).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
  }

  // Someone is in this call right now (my own app tells the model through the voice states it
  // keeps for friends; for myself, ask voice.js)
  callLive (g, c, mine = false) {
    if (mine) return true
    for (const st of g.voice.values()) if (st.call === c.id && st.ch === DM_CALL) return true
    return false
  }

  callStatusOf (g, c, mine = false) {
    return callStatus(c, this.me.key, this.callLive(g, c, mine))
  }

  markRead (gid, chId) {
    const g = this.groups.get(gid)
    const list = g?.messages.get(chId)
    let last = list && list.length ? list[list.length - 1].t : 0
    // a call in a private chat counts as read along with its messages
    if (g?.dm && chId === DM_TEXT) for (const c of g.calls.values()) if (c.by && c.t > last) last = c.t
    const k = gid + ':' + chId
    if ((this.lastRead[k] || 0) >= last) return
    this.lastRead[k] = last
    try { localStorage.setItem('od.lastRead', JSON.stringify(this.lastRead)) } catch {}
    this.emit()
  }

  // Channel messages, plus new replies in threads you follow (or that mention you)
  unread (g, chId) {
    const list = g.messages.get(chId) || []
    const since = this.lastRead[g.id + ':' + chId] || g.joinedAt
    let count = 0
    let mentions = 0
    for (let i = list.length - 1; i >= 0 && list[i].t > since; i--) {
      if (list[i].a === this.me.key && !list[i].bot) continue
      count++
      if (this.mentionsMe(list[i].text) || list[i].ping === this.me.key) mentions++
    }
    // calls you missed while away count like a message to you
    if (g.dm && chId === DM_TEXT) {
      for (const c of g.calls.values()) {
        if (!c.by || c.by === this.me.key || c.t <= since) continue
        if (this.callStatusOf(g, c) === 'missed') { count++; mentions++ }
      }
    }
    for (const [id, replies] of g.threads) {
      if (!replies.length || replies[0].ch !== chId) continue
      const tSince = this._threadSince(g, id)
      if (replies[replies.length - 1].t <= tSince) continue
      const follows = this.follows(g, id)
      for (let i = replies.length - 1; i >= 0 && replies[i].t > tSince; i--) {
        const r = replies[i]
        if (r.a === this.me.key || r.also) continue
        const mention = this.mentionsMe(r.text)
        if (follows || mention) count++
        if (mention) mentions++
      }
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
