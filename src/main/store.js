'use strict'
// Local persistence. Each group is an append-only log of signed ops.
// Every author numbers their own ops 1,2,3,... so two peers can sync by exchanging a
// tiny version vector {author: highestSeq} and sending each other what is missing.
// Peers only ever store a contiguous prefix of each author's ops, which keeps that
// invariant true even when ops are gossiped through a third friend.
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const c = require('./crypto')

const MAX_OP_BYTES = 64 * 1024
// Profile pictures travel inside the (signed) profile op as a small data URL, so they sync with
// the history and show even when the friend is offline. The UI crops and shrinks them to 256 px.
const MAX_AVATAR_CHARS = 48 * 1024
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const isAvatar = (s) => typeof s === 'string' && s.length <= MAX_AVATAR_CHARS && AVATAR_RE.test(s)
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)
// Ops that change who is allowed in (see _recomputeMembership)
const MEMBERSHIP_KINDS = new Set(['group.init', 'member.role', 'member.kick'])

const DEFAULT_SETTINGS = {
  // STUN servers only tell your computer its public IP:port so WebRTC can hole-punch.
  // They never see or forward any audio/video. TURN (relay) servers are not supported.
  stunServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  autoDownloadMB: 25,
  closeToTray: true,
  notifications: true,
  audio: {
    inputId: 'default',
    outputId: 'default',
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceBitrate: 96000,
    // 'ai' = RNNoise neural network + voice gate, 'standard' = Chromium's built-in filter
    noiseMode: 'ai'
  },
  // Make previews for links you send (your app fetches the page; friends' apps never do)
  linkPreviews: true,
  screen: { preset: '1080p60', contentHint: 'motion', codec: 'auto', audio: false },
  volumes: {},
  localMutes: {}, // key -> true: people you muted for yourself
  // Check GitHub for new versions and install them on restart
  autoUpdate: true
}

const COLORS = ['#2dd4bf', '#f472b6', '#fbbf24', '#60a5fa', '#a78bfa', '#f87171', '#4ade80', '#fb923c']

function writeJSONAtomic (file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function readJSON (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function mergeSettings (base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

class Store extends EventEmitter {
  constructor (dir) {
    super()
    this.dir = dir
    this.groupsDir = path.join(dir, 'groups')
    this.blobsDir = path.join(dir, 'blobs')
    this.groups = new Map()
  }

  load () {
    fs.mkdirSync(this.groupsDir, { recursive: true })
    fs.mkdirSync(this.blobsDir, { recursive: true })

    const idFile = path.join(this.dir, 'identity.json')
    let identity = readJSON(idFile, null)
    if (!identity || typeof identity.seed !== 'string' || identity.seed.length !== 64) {
      identity = { seed: c.randomBytes(32).toString('hex'), name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] }
      writeJSONAtomic(idFile, identity)
    }
    this.identity = identity
    this.seed = Buffer.from(identity.seed, 'hex')
    this.keyPair = c.keyPair(this.seed)
    this.myKey = this.keyPair.publicKey.toString('hex')

    this.settings = mergeSettings(DEFAULT_SETTINGS, readJSON(path.join(this.dir, 'settings.json'), {}))
    this._loadFriends()

    for (const name of fs.readdirSync(this.groupsDir)) {
      const meta = readJSON(path.join(this.groupsDir, name, 'meta.json'), null)
      if (!meta || !(meta.secret || meta.epochs)) continue
      this._loadGroup(meta)
    }
    return this
  }

  _groupDir (id) { return path.join(this.groupsDir, id) }

  // A group's secret changes every time someone is kicked ("epochs"). The id stays the same.
  // meta.json: { id, epochs: { "0": hex, "1": hex }, owner, nameHint, joinedAt }
  _loadGroup (meta) {
    const epochs = new Map()
    if (meta.epochs) for (const [e, hex] of Object.entries(meta.epochs)) epochs.set(Number(e), Buffer.from(hex, 'hex'))
    else epochs.set(0, Buffer.from(meta.secret, 'hex'))
    const group = {
      id: meta.id || c.groupIdFromSecret(epochs.get(Math.min(...epochs.keys()))),
      epochs,
      owner: /^[0-9a-f]{64}$/.test(meta.owner || '') ? meta.owner : null,
      nameHint: meta.nameHint || '',
      joinedAt: meta.joinedAt || Date.now(),
      ops: [],
      byAuthor: new Map(),
      admins: new Set(),
      kicks: new Map(), // key -> { epoch, upTo }: refused on keys older than `epoch`
      kickedMe: false,
      dm: /^[0-9a-f]{64}$/.test(meta.dm || '') ? meta.dm : null // private chat with this friend
    }
    this._setEpochs(group)
    const file = path.join(this._groupDir(group.id), 'ops.ndjson')
    let raw = ''
    try { raw = fs.readFileSync(file, 'utf8') } catch {}
    for (const line of raw.split('\n')) {
      if (!line) continue
      let op
      try { op = JSON.parse(line) } catch { continue } // torn write after a crash
      const list = group.byAuthor.get(op.a) || []
      if (op.s !== list.length + 1) continue
      list.push(op)
      group.byAuthor.set(op.a, list)
      group.ops.push(op)
    }
    this.groups.set(group.id, group)
    this._recomputeMembership(group)
    return group
  }

  _setEpochs (g) {
    g.epoch = Math.max(...g.epochs.keys())
    g.secret = g.epochs.get(g.epoch)
    g.topic = c.topicFromSecret(g.secret)
    // Old topics stay announced so members who were offline during a kick can still find us
    // and pick up the new key.
    g.topics = [...g.epochs.values()].map(s => c.topicFromSecret(s))
  }

  _saveMeta (g) {
    const epochs = {}
    for (const [e, s] of g.epochs) epochs[e] = s.toString('hex')
    const meta = {
      id: g.id,
      secret: g.epochs.get(Math.min(...g.epochs.keys())).toString('hex'),
      epochs,
      owner: g.owner,
      dm: g.dm || undefined,
      nameHint: g.nameHint,
      joinedAt: g.joinedAt
    }
    fs.mkdirSync(this._groupDir(g.id), { recursive: true })
    writeJSONAtomic(path.join(this._groupDir(g.id), 'meta.json'), meta)
  }

  // ---- membership: owner, admins, kicks ----
  //
  // The owner is the group's creator. Invites carry the owner's key, and the first value we
  // learn is pinned, so a member can't take over by forging a group.init. The owner appoints
  // admins. The owner and admins can kick: that rotates the group secret and hands the new one
  // to every remaining member in sealed boxes inside the signed kick op. Nothing else
  // (chat, channels, names) needs a role.

  _adminAt (g, key, t = Infinity) {
    let admin = false
    for (const op of g.ops) {
      if (op.k === 'member.role' && op.a === g.owner && op.d.key === key && op.t <= t) admin = op.d.role === 'admin'
    }
    return admin
  }

  canModerate (g, actor, target, t = Infinity) {
    if (!isKey(target) || target === actor || target === g.owner) return false
    if (actor === g.owner) return true
    return this._adminAt(g, actor, t) && !this._adminAt(g, target, t)
  }

  // Everyone who has posted anything and is not currently kicked.
  members (g) {
    const out = []
    for (const [key, list] of g.byAuthor) {
      const k = g.kicks.get(key)
      if (!k || list.length > k.upTo) out.push(key)
    }
    return out
  }

  _recomputeMembership (g) {
    const before = JSON.stringify([g.owner, [...g.admins], [...g.kicks], g.kickedMe, g.epoch])
    const timeOrder = (x, y) => x.t - y.t || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.s - y.s)
    if (!g.owner) {
      const init = g.ops.filter(op => op.k === 'group.init').sort(timeOrder)[0]
      if (init) g.owner = init.a
    }
    const roles = g.ops.filter(op => op.k === 'member.role' && op.a === g.owner && isKey(op.d.key)).sort(timeOrder)
    g.admins = new Set()
    for (const op of roles) {
      if (op.d.role === 'admin') g.admins.add(op.d.key)
      else g.admins.delete(op.d.key)
    }
    g.kicks = new Map()
    let gotKey = false
    for (const op of g.ops.filter(op => op.k === 'member.kick').sort(timeOrder)) {
      const { key, epoch, upTo, boxes } = op.d
      if (!Number.isInteger(epoch) || epoch < 1 || !this.canModerate(g, op.a, key, op.t)) continue
      const prev = g.kicks.get(key)
      if (!prev || prev.epoch < epoch) g.kicks.set(key, { epoch, upTo: Number.isInteger(upTo) ? upTo : 0, by: op.a, t: op.t })
      const box = boxes && typeof boxes === 'object' ? boxes[this.myKey] : null
      if (box && !g.epochs.has(epoch)) {
        const secret = c.openSealed(this.keyPair, box)
        if (secret && secret.length === 32) { g.epochs.set(epoch, secret); gotKey = true }
      }
    }
    const mine = g.kicks.get(this.myKey)
    g.kickedMe = !!mine && mine.epoch > g.epoch
    if (gotKey) this._setEpochs(g)
    const after = JSON.stringify([g.owner, [...g.admins], [...g.kicks], g.kickedMe, g.epoch])
    if (gotKey || after !== before) this._saveMeta(g)
    return after !== before
  }

  // Should a peer who proved knowledge of this group's key for `epoch` get access?
  authorize (g, key, epoch) {
    if (key === this.myKey) return false
    if (g.dm) return key === g.dm // a private chat is exactly two people
    const kick = g.kicks.get(key)
    if (kick && epoch < kick.epoch) return false
    if (epoch >= g.epoch) return true // has the current key: a member (possibly re-invited)
    return g.byAuthor.has(key) // older key: only existing members, so they can fetch the new one
  }

  membershipInfo (g) {
    return {
      owner: g.owner,
      admins: [...g.admins],
      removed: [...g.kicks.keys()].filter(k => !this.members(g).includes(k)),
      kickedMe: g.kickedMe,
      epoch: g.epoch
    }
  }

  kick (groupId, key) {
    const g = this.groups.get(groupId)
    if (!g) throw new Error('Unknown group')
    if (!this.canModerate(g, this.myKey, key)) throw new Error("You don't have permission to remove this person")
    const epoch = g.epoch + 1
    const secret = c.randomBytes(32)
    const boxes = {}
    for (const m of this.members(g)) if (m !== key) boxes[m] = c.sealTo(m, secret)
    boxes[this.myKey] = c.sealTo(this.myKey, secret)
    return this.append(groupId, 'member.kick', { key, epoch, upTo: (g.byAuthor.get(key) || []).length, boxes })
  }

  setRole (groupId, key, role) {
    const g = this.groups.get(groupId)
    if (!g) throw new Error('Unknown group')
    if (g.owner !== this.myKey) throw new Error('Only the group owner can change roles')
    if (!isKey(key) || key === this.myKey || !['admin', 'member'].includes(role)) throw new Error('Invalid role change')
    return this.append(groupId, 'member.role', { key, role })
  }

  // ---- identity & settings ----

  setProfile ({ name, color, avatar }) {
    if (typeof name === 'string') this.identity.name = name.trim().slice(0, 32)
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) this.identity.color = color
    if (avatar === null) delete this.identity.avatar
    else if (avatar !== undefined) {
      if (!isAvatar(avatar)) throw new Error('Profile picture must be a small PNG, JPEG or WebP image')
      this.identity.avatar = avatar
    }
    writeJSONAtomic(path.join(this.dir, 'identity.json'), this.identity)
    return this.publicIdentity()
  }

  // What goes into 'profile' ops. Each one is the full profile, so leaving out the avatar
  // removes it.
  profileData () {
    const d = { name: this.identity.name, color: this.identity.color }
    if (this.identity.avatar) d.avatar = this.identity.avatar
    return d
  }

  publicIdentity () {
    return { key: this.myKey, name: this.identity.name, color: this.identity.color, avatar: this.identity.avatar || null }
  }

  setSettings (patch) {
    this.settings = mergeSettings(this.settings, patch)
    writeJSONAtomic(path.join(this.dir, 'settings.json'), this.settings)
    return this.settings
  }

  // ---- groups ----

  _createGroup ({ id, secret, epoch = 0, owner = null, nameHint = '', dm }) {
    fs.mkdirSync(this._groupDir(id), { recursive: true })
    const meta = { id, secret: secret.toString('hex'), epochs: { [epoch]: secret.toString('hex') }, owner, nameHint, joinedAt: Date.now(), dm }
    writeJSONAtomic(path.join(this._groupDir(id), 'meta.json'), meta)
    return this._loadGroup(meta)
  }

  createGroup (name) {
    name = String(name || '').trim().slice(0, 64) || 'New group'
    const secret = c.randomBytes(32)
    const group = this._createGroup({ id: c.groupIdFromSecret(secret), secret, owner: this.myKey, nameHint: name })
    const rnd = () => c.randomBytes(8).toString('hex')
    this.append(group.id, 'group.init', { name })
    this.append(group.id, 'channel.create', { id: rnd(), name: 'general', kind: 'text' })
    this.append(group.id, 'channel.create', { id: rnd(), name: 'General', kind: 'voice' })
    this.append(group.id, 'profile', this.profileData())
    return group
  }

  // Returns { group, existed, rekeyed }. Joining a group you're already in with a newer invite
  // (e.g. after being kicked and re-invited) just adds the new key.
  joinGroup (invite) {
    const { secret, name, id, epoch, owner } = c.parseInvite(invite)
    const existing = this.groups.get(id)
    if (existing) {
      const had = existing.epochs.get(epoch)
      if (had && had.equals(secret)) return { group: existing, existed: true, rekeyed: false }
      existing.epochs.set(epoch, secret)
      if (!existing.owner && owner) existing.owner = owner
      this._setEpochs(existing)
      this._recomputeMembership(existing)
      this._saveMeta(existing)
      return { group: existing, existed: true, rekeyed: true }
    }
    const group = this._createGroup({ id, secret, epoch, owner, nameHint: name })
    this.append(group.id, 'profile', this.profileData())
    return { group, existed: false, rekeyed: false }
  }

  leaveGroup (id) {
    const group = this.groups.get(id)
    if (!group) return null
    this.groups.delete(id)
    fs.rmSync(this._groupDir(id), { recursive: true, force: true })
    return group
  }

  inviteFor (id) {
    const g = this.groups.get(id)
    if (!g) throw new Error('Unknown group')
    if (g.dm) throw new Error("Private chats can't have invites")
    return c.makeInvite(g.secret, this.groupName(g), { id: g.id, epoch: g.epoch, owner: g.owner })
  }

  groupName (g) {
    let name = g.nameHint
    let best = -1
    for (const op of g.ops) {
      if ((op.k === 'group.init' || op.k === 'group.rename') && op.t > best && typeof op.d?.name === 'string') {
        best = op.t
        name = op.d.name
      }
    }
    return name
  }

  // ---- friends & private chats ----
  //
  // A friendship is a private chat "group" whose secret comes from a key exchange between the
  // two identity keys (crypto.dmSecret). Friend requests are delivered directly from app to app
  // (network.sendFriendRequest); pending ones live in friends.json.

  _friendsFile () { return path.join(this.dir, 'friends.json') }
  _loadFriends () {
    const f = readJSON(this._friendsFile(), null) || {}
    this.friends = { incoming: f.incoming || {}, outgoing: f.outgoing || {} }
  }
  _saveFriends () { writeJSONAtomic(this._friendsFile(), this.friends) }

  friendCode () { return c.makeFriendCode(this.myKey, this.identity.name) }

  dmWith (key) {
    for (const g of this.groups.values()) if (g.dm === key) return g
    return null
  }

  // Did the friend accept? They have, once they've posted into the private chat.
  isFriend (key) {
    const g = this.dmWith(key)
    return !!g && g.byAuthor.has(key)
  }

  openDm (key, name = '') {
    if (!isKey(key) || key === this.myKey) throw new Error("That's not a valid friend")
    const existing = this.dmWith(key)
    if (existing) return existing
    const secret = c.dmSecret(this.keyPair, key)
    const g = this._createGroup({ id: c.groupIdFromSecret(secret), secret, nameHint: name, dm: key })
    this.append(g.id, 'profile', this.profileData())
    return g
  }

  // Add by friend code, or by key from a shared group. Adding someone who already asked you = accepting.
  addFriend (codeOrKey, name = '') {
    const parsed = c.parseFriendCode(codeOrKey)
    if (parsed.key === this.myKey) throw new Error("That's your own friend code")
    const label = parsed.name || name
    const g = this.openDm(parsed.key, label)
    if (this.friends.incoming[parsed.key]) delete this.friends.incoming[parsed.key]
    else if (!this.isFriend(parsed.key)) this.friends.outgoing[parsed.key] = { name: label, at: Date.now() }
    this._saveFriends()
    return { group: g, key: parsed.key }
  }

  acceptFriend (key) {
    const req = this.friends.incoming[key]
    if (!req) throw new Error('No friend request from them')
    const g = this.openDm(key, req.name)
    delete this.friends.incoming[key]
    this._saveFriends()
    return g
  }

  declineFriend (key) {
    delete this.friends.incoming[key]
    this._saveFriends()
  }

  // Returns the private chat group to leave, if any.
  removeFriend (key) {
    delete this.friends.outgoing[key]
    delete this.friends.incoming[key]
    this._saveFriends()
    const g = this.dmWith(key)
    return g ? this.leaveGroup(g.id) : null
  }

  // A request arrived from `key`. Returns true if it's new and should be shown.
  receiveFriendRequest (key, { name, color } = {}) {
    if (!isKey(key) || key === this.myKey) return false
    if (this.dmWith(key)) return false // we already added them: their request is the acceptance
    if (this.friends.incoming[key]) return false
    if (Object.keys(this.friends.incoming).length >= 100) return false
    this.friends.incoming[key] = { name: String(name || '').slice(0, 32), color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : null, at: Date.now() }
    this._saveFriends()
    return true
  }

  // Outgoing requests the other side hasn't accepted yet
  pendingOutgoing () {
    for (const key of Object.keys(this.friends.outgoing)) {
      if (this.isFriend(key)) delete this.friends.outgoing[key]
    }
    return Object.keys(this.friends.outgoing)
  }

  friendsInfo () {
    const out = { code: this.friendCode(), incoming: [], outgoing: [] }
    for (const [key, r] of Object.entries(this.friends.incoming)) out.incoming.push({ key, ...r })
    for (const key of this.pendingOutgoing()) out.outgoing.push({ key, ...this.friends.outgoing[key] })
    return out
  }

  // ---- ops ----

  append (groupId, kind, data) {
    const g = this.groups.get(groupId)
    if (!g) throw new Error('Unknown group')
    const mine = g.byAuthor.get(this.myKey) || []
    const op = { g: groupId, a: this.myKey, s: mine.length + 1, t: Date.now(), k: String(kind), d: data ?? {} }
    if (Buffer.byteLength(JSON.stringify(op)) > MAX_OP_BYTES) throw new Error('Message too large')
    op.sig = c.signOp(op, this.keyPair.secretKey)
    mine.push(op)
    g.byAuthor.set(this.myKey, mine)
    g.ops.push(op)
    fs.appendFileSync(path.join(this._groupDir(groupId), 'ops.ndjson'), JSON.stringify(op) + '\n')
    if (MEMBERSHIP_KINDS.has(op.k)) this._recomputeMembership(g)
    return op
  }

  // Validate and store ops received from a peer. Returns newly accepted ops and whether
  // a gap was detected (we got seq N+2 before N+1), in which case the caller re-syncs.
  ingest (groupId, ops) {
    const g = this.groups.get(groupId)
    const result = { accepted: [], gap: false, membership: false }
    if (!g || !Array.isArray(ops)) return result
    const valid = ops.filter(op => op && typeof op === 'object' && op.g === groupId &&
      Number.isInteger(op.s) && op.s > 0 && typeof op.t === 'number' &&
      typeof op.k === 'string' && op.k.length <= 32 && op.d && typeof op.d === 'object' &&
      typeof op.sig === 'string')
    valid.sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : x.s - y.s)
    for (const op of valid) {
      const list = g.byAuthor.get(op.a) || []
      if (op.s <= list.length) continue // already have it
      if (op.s > list.length + 1) { result.gap = true; continue }
      if (Buffer.byteLength(JSON.stringify(op)) > MAX_OP_BYTES + 256) continue
      if (!c.verifyOp(op)) continue
      const clean = { g: op.g, a: op.a, s: op.s, t: op.t, k: op.k, d: op.d, sig: op.sig }
      list.push(clean)
      g.byAuthor.set(op.a, list)
      g.ops.push(clean)
      result.accepted.push(clean)
    }
    if (result.accepted.length) {
      fs.appendFileSync(path.join(this._groupDir(groupId), 'ops.ndjson'),
        result.accepted.map(op => JSON.stringify(op)).join('\n') + '\n')
      if (result.accepted.some(op => MEMBERSHIP_KINDS.has(op.k))) result.membership = this._recomputeMembership(g)
    }
    return result
  }

  vector (groupId) {
    const g = this.groups.get(groupId)
    const vec = {}
    if (g) for (const [a, list] of g.byAuthor) vec[a] = list.length
    return vec
  }

  opsMissingFrom (groupId, theirVec) {
    const g = this.groups.get(groupId)
    const out = []
    if (!g) return out
    for (const [a, list] of g.byAuthor) {
      const have = Number(theirVec?.[a]) || 0
      if (have < list.length) out.push(...list.slice(have))
    }
    return out
  }

  // ---- blobs ----

  blobPath (hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Bad blob hash')
    return path.join(this.blobsDir, hash)
  }

  hasBlob (hash) {
    try { return fs.statSync(this.blobPath(hash)).isFile() } catch { return false }
  }
}

module.exports = { Store, DEFAULT_SETTINGS, COLORS, isAvatar, MAX_AVATAR_CHARS }
