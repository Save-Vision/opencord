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
    voiceBitrate: 96000
  },
  screen: { preset: '1080p60', contentHint: 'motion', codec: 'auto', audio: false },
  volumes: {},
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

    for (const name of fs.readdirSync(this.groupsDir)) {
      const meta = readJSON(path.join(this.groupsDir, name, 'meta.json'), null)
      if (!meta || !meta.secret) continue
      this._loadGroup(meta)
    }
    return this
  }

  _groupDir (id) { return path.join(this.groupsDir, id) }

  _loadGroup (meta) {
    const secret = Buffer.from(meta.secret, 'hex')
    const group = {
      id: c.groupIdFromSecret(secret),
      secret,
      topic: c.topicFromSecret(secret),
      nameHint: meta.nameHint || '',
      joinedAt: meta.joinedAt || Date.now(),
      ops: [],
      byAuthor: new Map()
    }
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
    return group
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

  _createGroupFromSecret (secret, nameHint) {
    const id = c.groupIdFromSecret(secret)
    if (this.groups.has(id)) return { group: this.groups.get(id), existed: true }
    fs.mkdirSync(this._groupDir(id), { recursive: true })
    const meta = { secret: secret.toString('hex'), nameHint, joinedAt: Date.now() }
    writeJSONAtomic(path.join(this._groupDir(id), 'meta.json'), meta)
    return { group: this._loadGroup(meta), existed: false }
  }

  createGroup (name) {
    name = String(name || '').trim().slice(0, 64) || 'New group'
    const { group } = this._createGroupFromSecret(c.randomBytes(32), name)
    const rnd = () => c.randomBytes(8).toString('hex')
    this.append(group.id, 'group.init', { name })
    this.append(group.id, 'channel.create', { id: rnd(), name: 'general', kind: 'text' })
    this.append(group.id, 'channel.create', { id: rnd(), name: 'General', kind: 'voice' })
    this.append(group.id, 'profile', this.profileData())
    return group
  }

  joinGroup (invite) {
    const { secret, name } = c.parseInvite(invite)
    const { group, existed } = this._createGroupFromSecret(secret, name)
    if (!existed) this.append(group.id, 'profile', this.profileData())
    return { group, existed }
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
    return c.makeInvite(g.secret, this.groupName(g))
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
    return op
  }

  // Validate and store ops received from a peer. Returns newly accepted ops and whether
  // a gap was detected (we got seq N+2 before N+1), in which case the caller re-syncs.
  ingest (groupId, ops) {
    const g = this.groups.get(groupId)
    const result = { accepted: [], gap: false }
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
