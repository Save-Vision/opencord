'use strict'
// Local persistence. Each group is an append-only log of signed ops.
// Every author numbers their own ops 1,2,3,... so two peers can sync by exchanging a
// tiny version vector {author: highestSeq} and sending each other what is missing.
// Peers only ever store a contiguous prefix of each author's ops, which keeps that
// invariant true even when ops are gossiped through a third friend.
//
// On disk (0.4+), per group folder:
//   ops.ndjson      the newest ops, one JSON line each, appended as they arrive
//   seg-000001.br   older ops, Brotli-compressed, ~2 MB of JSON per segment
// Every so often the plain log is folded into the segments. Lines leave out the group id
// (it's the folder name). Ops nobody needs any more (a deleted message, an older version of
// an edited message, older profile pictures) are replaced by small "stubs", see SUPERSEDES.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nodeCrypto = require('crypto')
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
const timeOrder = (x, y) => x.t - y.t || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.s - y.s)
const isHex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v)

// ---- superseded ops ----
// A later op can declare some of the same author's earlier ops obsolete by listing their
// seqs in d.sup. Everyone then keeps only a stub { a, s, t, k: 'x', by } in its place: the
// sequence stays gap-free, and the signed op `by` vouches for the stub when it's synced on.
// Rules: which earlier ops each kind may replace.
const SUPERSEDES = {
  'msg.delete': (t, d) => ['msg', 'msg.edit', 'msg.embed'].includes(t.k) && t.d.id === d.id,
  'msg.edit': (t, d) => t.k === 'msg.edit' && t.d.id === d.id,
  profile: (t) => t.k === 'profile',
  'group.icon': (t) => t.k === 'group.icon',
  'event.delete': (t, d) => (t.k === 'event.set' || t.k === 'event.rsvp') && t.d.id === d.id,
  'task.delete': (t, d) => t.k === 'task.set' && t.d.id === d.id
}
const STUB = 'x'
const isStub = (op) => op.k === STUB
// What a stub remembers of the op it replaced, so later sup lists can still name it
const stubMatches = (stub, rule, d) => rule({ k: stub.ok, d: { id: stub.oid } }, d)

const SEG_RAW_MAX = 2 * 1024 * 1024 // JSON bytes per segment
const HOT_MAX = 128 * 1024 // fold the plain log into segments past this size
const brotli = (quality, size) => ({
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
  }
})
function diskLine (op) {
  const { g, ...rest } = op
  return JSON.stringify(rest)
}

// A password-protected copy of your account (Settings → Account): your identity, the keys of
// your groups and private chats, and your friends. History isn't in it: it syncs back from
// friends after a restore.
const BACKUP_KIND = 'opendiscord-backup'
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

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
  // Look: 'standard', 'minimal', 'xp', 'glass' or 'oled' (renderer/lib/themes.js); the Glass theme's
  // moving background can be switched off
  theme: 'standard',
  // 'light', 'dark', 'system' (follow the OS) or null (the theme's own)
  mode: null,
  animatedBg: true,
  // Order and widths of the floating panels (renderer/lib/layout.js); null = default
  layout: null,
  screen: { preset: '1080p60', contentHint: 'motion', codec: 'auto', audio: false },
  volumes: {},
  // Remove files your friends sent after this many days (0 = keep). Your own files always
  // stay, and removed ones can be downloaded again from friends who still have them.
  cleanFriendsFilesDays: 0,
  localMutes: {}, // key -> true: people you muted for yourself
  screenVolumes: {}, // key -> volume of that friend's stream sound
  screenMutes: {}, // key -> true: their stream's sound is muted for you
  // Check GitHub for new versions and install them on restart
  autoUpdate: true,
  // @claude: which model answers, and whether it may search the web (the API key itself is
  // kept encrypted in claude.json, see claude.js)
  claude: { model: 'claude-opus-5-5', web: false },
  // Join/leave/mute chimes and the soundboard
  sounds: { volume: 0.6, voice: true, soundboard: true, soundboardVolume: 0.7 },
  // What friends see: 'online' | 'away' | 'invisible' (appear offline). Online turns to away
  // after autoAway minutes without input (0 = never).
  status: 'online',
  autoAway: 10
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
    // Superseded ops become stubs this long after the op that replaces them, so friends still
    // on 0.3 (which can't check stubs, see wire) aren't cut off while their app updates.
    const delay = Number(process.env.OD_STUB_DELAY_MS)
    this.stubDelay = Number.isFinite(delay) && delay >= 0 ? delay : 2 * 864e5
  }

  // Runs every hour: makes the stubs that are due and folds big plain logs into segments
  sweep () {
    for (const g of this.groups.values()) {
      for (const op of g.ops) if (Array.isArray(op.d?.sup)) this._applySup(g, op)
      this._scheduleCompact(g)
    }
  }

  // seal/unseal (optional): encrypt the identity's secret with the OS keychain (Electron
  // safeStorage: DPAPI on Windows), so a copy of the data folder alone can't impersonate you.
  load ({ seal = null, unseal = null } = {}) {
    fs.mkdirSync(this.groupsDir, { recursive: true })
    fs.mkdirSync(this.blobsDir, { recursive: true })
    this.seal = seal

    const idFile = path.join(this.dir, 'identity.json')
    let identity = readJSON(idFile, null)
    let seedHex = null
    if (identity && typeof identity.seedEnc === 'string') {
      try { seedHex = unseal ? unseal(identity.seedEnc) : null } catch {}
      if (!/^[0-9a-f]{64}$/.test(seedHex || '')) {
        const err = new Error('This account was encrypted for another Windows user or PC')
        err.code = 'IDENTITY_LOCKED'
        throw err
      }
    } else if (identity && /^[0-9a-f]{64}$/.test(identity.seed || '')) {
      seedHex = identity.seed
    } else {
      identity = { name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] }
      seedHex = c.randomBytes(32).toString('hex')
      identity.seed = seedHex
    }
    this.identity = identity
    this._sealSeed(seedHex)
    this.seed = Buffer.from(seedHex, 'hex')
    this.keyPair = c.keyPair(this.seed)
    this.myKey = this.keyPair.publicKey.toString('hex')

    this.settings = mergeSettings(DEFAULT_SETTINGS, readJSON(path.join(this.dir, 'settings.json'), {}))
    this._loadFriends()

    this.joins = readJSON(path.join(this.dir, 'joins.json'), null) || {}

    for (const name of fs.readdirSync(this.groupsDir)) {
      const meta = readJSON(path.join(this.groupsDir, name, 'meta.json'), null)
      if (!meta || !(meta.secret || meta.epochs)) continue
      const g = this._loadGroup(meta)
      // First start after an update (or a big backlog): fold the plain log into segments
      if (g.hotBytes > 16 * 1024 || g.hotDirty || g.segs.some(s => s.dirty)) this.compact(g)
    }
    return this
  }

  // identity.json keeps the secret encrypted when the OS can (and plain otherwise, e.g. Linux
  // without a keyring)
  _sealSeed (seedHex) {
    let enc = null
    try { enc = this.seal ? this.seal(seedHex) : null } catch {}
    if (enc) { this.identity.seedEnc = enc; delete this.identity.seed } else if (!this.identity.seedEnc) this.identity.seed = seedHex
    writeJSONAtomic(path.join(this.dir, 'identity.json'), this.identity)
  }

  get sealed () { return !!this.identity.seedEnc }

  // ---- backup & restore ----

  exportBackup (password) {
    if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password with at least 8 characters')
    const groups = []
    for (const g of this.groups.values()) groups.push(this._metaOf(g))
    const plain = Buffer.from(JSON.stringify({
      kind: BACKUP_KIND,
      v: 1,
      created: Date.now(),
      identity: {
        seed: this.seed.toString('hex'),
        name: this.identity.name,
        color: this.identity.color,
        avatar: this.identity.avatar || undefined,
        claude: this.identity.claude ? true : undefined
      },
      groups,
      friends: this.friends
    }))
    const salt = nodeCrypto.randomBytes(16)
    const iv = nodeCrypto.randomBytes(12)
    const key = nodeCrypto.scryptSync(password.normalize('NFC'), salt, 32, SCRYPT)
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    return JSON.stringify({
      kind: BACKUP_KIND,
      v: 1,
      key: this.myKey,
      name: this.identity.name,
      created: Date.now(),
      kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    }, null, 1)
  }

  // Decrypts and checks a backup file. Throws a message the user can act on.
  static openBackup (text, password) {
    let f
    try { f = JSON.parse(String(text)) } catch { throw new Error("That isn't an OpenDiscord backup file") }
    if (!f || f.kind !== BACKUP_KIND || f.v !== 1 || !f.kdf || f.kdf.name !== 'scrypt') throw new Error("That isn't an OpenDiscord backup file")
    const N = Number(f.kdf.N)
    if (!(N >= 1024 && N <= (1 << 20) && (N & (N - 1)) === 0)) throw new Error('This backup file is damaged')
    let plain
    try {
      const key = nodeCrypto.scryptSync(String(password || '').normalize('NFC'), Buffer.from(f.kdf.salt, 'base64'), 32, { N, r: Number(f.kdf.r) || 8, p: Number(f.kdf.p) || 1, maxmem: 256 * 1024 * 1024 })
      const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'))
      d.setAuthTag(Buffer.from(f.tag, 'base64'))
      plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()])
    } catch {
      throw new Error('Wrong password (or the file is damaged)')
    }
    const b = JSON.parse(plain.toString('utf8'))
    if (b.kind !== BACKUP_KIND || !/^[0-9a-f]{64}$/.test(b.identity?.seed || '') || !Array.isArray(b.groups)) throw new Error('This backup file is damaged')
    return b
  }

  // Replaces the account on this PC with the one from a backup. What was here moves to a
  // "replaced-…" folder (nothing is deleted); files stay, as they're shared by content.
  // Every group starts out "restoring": see noteVector.
  // Moves the account files (not settings or files) into a folder next to them
  static setAside (dir, label) {
    const stash = path.join(dir, label + '-' + new Date().toISOString().replace(/[:.]/g, '-'))
    fs.mkdirSync(stash, { recursive: true })
    for (const name of ['identity.json', 'friends.json', 'joins.json', 'groups']) {
      const from = path.join(dir, name)
      if (fs.existsSync(from)) fs.renameSync(from, path.join(stash, name))
    }
    return stash
  }

  restoreBackup (b) {
    const stash = Store.setAside(this.dir, 'replaced')
    fs.mkdirSync(this.groupsDir, { recursive: true })
    const id = b.identity
    this.identity = { name: String(id.name || '').slice(0, 32), color: /^#[0-9a-f]{6}$/i.test(id.color || '') ? id.color : COLORS[0] }
    if (isAvatar(id.avatar)) this.identity.avatar = id.avatar
    if (id.claude) this.identity.claude = true
    this._sealSeed(id.seed)
    for (const meta of b.groups) {
      if (!meta || !/^[0-9a-f]{32}$/.test(meta.id || '') || !(meta.secret || meta.epochs)) continue
      fs.mkdirSync(this._groupDir(meta.id), { recursive: true })
      writeJSONAtomic(path.join(this._groupDir(meta.id), 'meta.json'), { ...meta, restoring: true })
    }
    const fr = b.friends || {}
    writeJSONAtomic(this._friendsFile(), { incoming: fr.incoming || {}, outgoing: fr.outgoing || {}, links: fr.links || {} })
    return stash
  }

  // After a restore, our own old ops come back from friends first: posting before that would
  // reuse op numbers they already hold. So a restored group stays read-only until a friend's app
  // told us (in its sync request) how many of our ops it has, and we have at least as many.
  noteVector (groupId, vec) {
    const g = this.groups.get(groupId)
    if (!g || !g.restoring) return false
    g.ownSeen = Math.max(g.ownSeen || 0, Number(vec?.[this.myKey]) || 0)
    g.vecSeen = true
    return this._checkRestored(g)
  }

  _checkRestored (g) {
    if (!g.restoring || !g.vecSeen) return false
    if ((g.byAuthor.get(this.myKey)?.length || 0) < g.ownSeen) return false
    g.restoring = false
    this._saveMeta(g)
    return true
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
      segs: [], // [{ n, ops, raw, bytes, dirty, ver }]
      hot: [], // ops in ops.ndjson
      hotBytes: 0,
      admins: new Set(),
      kicks: new Map(), // key -> { epoch, upTo }: refused on keys older than `epoch`
      kickedMe: false,
      dm: /^[0-9a-f]{64}$/.test(meta.dm || '') ? meta.dm : null, // private chat with this friend
      restoring: !!meta.restoring // restored from a backup and still catching up (see noteVector)
    }
    this._setEpochs(group)
    const dir = this._groupDir(group.id)
    let files = []
    try { files = fs.readdirSync(dir) } catch {}
    for (const f of files.filter(f => /^seg-\d{6}\.br$/.test(f)).sort()) {
      let raw
      const buf = fs.readFileSync(path.join(dir, f))
      try { raw = zlib.brotliDecompressSync(buf).toString('utf8') } catch (err) {
        console.warn('[store] unreadable segment', f, err.message)
        continue
      }
      const seg = { n: parseInt(f.slice(4, 10), 10), ops: [], raw: Buffer.byteLength(raw), bytes: buf.length, dirty: false, ver: 0 }
      this._readLines(group, raw, seg.ops)
      group.segs.push(seg)
    }
    let raw = ''
    try { raw = fs.readFileSync(path.join(dir, 'ops.ndjson'), 'utf8') } catch {}
    group.hotBytes = Buffer.byteLength(raw)
    this._readLines(group, raw, group.hot)
    this.groups.set(group.id, group)
    // stubs for anything superseded but still stored in full (e.g. a crash mid-way)
    for (const op of group.ops) if (Array.isArray(op.d?.sup)) this._applySup(group, op)
    this._recomputeMembership(group)
    return group
  }

  _readLines (g, raw, into) {
    for (const line of raw.split('\n')) {
      if (!line) continue
      let op
      try { op = JSON.parse(line) } catch { continue } // torn write after a crash
      if (!op || typeof op.a !== 'string') continue
      op.g = g.id
      const list = g.byAuthor.get(op.a) || []
      if (op.s !== list.length + 1) continue // duplicate (crash between two writes) or damaged
      list.push(op)
      g.byAuthor.set(op.a, list)
      g.ops.push(op)
      into.push(op)
    }
  }

  // ---- compaction ----

  _persist (g, ops) {
    const text = ops.map(diskLine).join('\n') + '\n'
    fs.appendFileSync(path.join(this._groupDir(g.id), 'ops.ndjson'), text)
    g.hot.push(...ops)
    g.hotBytes += Buffer.byteLength(text)
    this._scheduleCompact(g)
  }

  _scheduleCompact (g) {
    if (g.compactTimer || !(g.hotBytes > HOT_MAX || g.hotDirty || g.segs.some(s => s.dirty))) return
    g.compactTimer = setTimeout(() => {
      g.compactTimer = null
      if (this.groups.get(g.id) === g) {
        try { this.compact(g) } catch (err) { console.warn('[store] compact', err.message) }
      }
    }, 2000)
    g.compactTimer.unref?.()
  }

  // Rewrites segments that now hold stubs, then moves the plain log into segments.
  compact (g) {
    const dir = this._groupDir(g.id)
    for (const seg of g.segs) if (seg.dirty) this._writeSeg(g, seg)
    if (!g.hot.length) {
      if (g.hotBytes) { fs.writeFileSync(path.join(dir, 'ops.ndjson'), ''); g.hotBytes = 0 }
      return
    }
    let last = g.segs[g.segs.length - 1]
    const touched = new Set()
    for (const op of g.hot) {
      if (!last || last.raw >= SEG_RAW_MAX) {
        last = { n: (last ? last.n : 0) + 1, ops: [], raw: 0, bytes: 0, dirty: false, ver: 0 }
        g.segs.push(last)
      }
      last.ops.push(op)
      last.raw += Buffer.byteLength(diskLine(op)) + 1
      touched.add(last)
    }
    for (const seg of touched) this._writeSeg(g, seg)
    g.hot = []
    g.hotDirty = false
    fs.writeFileSync(path.join(dir, 'ops.ndjson'), '')
    g.hotBytes = 0
  }

  _segFile (g, seg) { return path.join(this._groupDir(g.id), `seg-${String(seg.n).padStart(6, '0')}.br`) }

  _writeSeg (g, seg) {
    const text = seg.ops.map(diskLine).join('\n') + '\n'
    seg.raw = Buffer.byteLength(text)
    const buf = zlib.brotliCompressSync(text, brotli(7, seg.raw))
    const file = this._segFile(g, seg)
    fs.writeFileSync(file + '.tmp', buf)
    fs.renameSync(file + '.tmp', file)
    seg.bytes = buf.length
    seg.dirty = false
    const ver = ++seg.ver
    // A full segment rarely changes again: squeeze it further in the background (~15 % smaller)
    if (seg.raw >= SEG_RAW_MAX) {
      zlib.brotliCompress(text, brotli(11, seg.raw), (err, best) => {
        if (err || seg.ver !== ver || seg.dirty || this.groups.get(g.id) !== g || best.length >= seg.bytes) return
        try {
          fs.writeFileSync(file + '.tmp', best)
          fs.renameSync(file + '.tmp', file)
          seg.bytes = best.length
        } catch {}
      })
    }
  }

  // ---- stubs ----

  // Replace op (author a, seq s) by a stub vouched for by the op with seq `by`
  _stubAt (g, a, s, by, original) {
    const list = g.byAuthor.get(a)
    const old = list && list[s - 1]
    if (!old) return false
    const stub = isStub(old)
      ? { ...old, by }
      : { g: g.id, a, s, t: old.t, k: STUB, d: {}, sig: '', by, ok: original.k, oid: typeof original.d?.id === 'string' ? original.d.id.slice(0, 32) : undefined }
    list[s - 1] = stub
    const i = g.ops.lastIndexOf(old)
    if (i >= 0) g.ops[i] = stub
    const h = g.hot.lastIndexOf(old)
    if (h >= 0) {
      g.hot[h] = stub
      g.hotDirty = true
    } else {
      for (let k = g.segs.length - 1; k >= 0; k--) {
        const j = g.segs[k].ops.lastIndexOf(old)
        if (j >= 0) { g.segs[k].ops[j] = stub; g.segs[k].dirty = true; break }
      }
    }
    return true
  }

  // Apply op.d.sup: turn the author's listed earlier ops into stubs (if the rule allows it)
  _applySup (g, op) {
    const rule = SUPERSEDES[op.k]
    if (!rule || !Array.isArray(op.d.sup) || Date.now() - op.t < this.stubDelay) return 0
    const list = g.byAuthor.get(op.a) || []
    let n = 0
    for (const s of op.d.sup.slice(0, 1000)) {
      if (!Number.isInteger(s) || s < 1 || s >= op.s) continue
      const target = list[s - 1]
      if (!target) continue
      if (isStub(target)) {
        if (target.by < op.s && stubMatches(target, rule, op.d)) { this._stubAt(g, op.a, s, op.s, target); n++ }
      } else if (!MEMBERSHIP_KINDS.has(target.k) && rule(target, op.d)) {
        this._stubAt(g, op.a, s, op.s, target)
        n++
      }
    }
    // stubbed ops in the plain log are rewritten when it's folded into a segment
    if (n) this._scheduleCompact(g)
    return n
  }

  // My own earlier ops that a new op of `kind` makes obsolete
  _supFor (g, kind, d) {
    const rule = SUPERSEDES[kind]
    if (!rule) return null
    const out = []
    for (const op of g.byAuthor.get(this.myKey) || []) {
      if (isStub(op) ? stubMatches(op, rule, d) : !MEMBERSHIP_KINDS.has(op.k) && rule(op, d)) out.push(op.s)
    }
    return out.length ? out.slice(-1000) : null
  }

  // Ops ready to send to a peer. Stubs travel with the op that vouches for them (`proofs`,
  // unless it's in the same batch). Peers from before 0.4 can't check stubs: for them an
  // author's ops stop at the first stub (they catch up once they update).
  wire (groupId, ops, { stubs = true } = {}) {
    const g = this.groups.get(groupId)
    if (!g || !ops.some(isStub)) return { ops, proofs: [] }
    const out = []
    const proofs = []
    const stopped = new Set()
    const inBatch = new Set(ops.filter(op => !isStub(op)).map(op => op.a + ':' + op.s))
    const added = new Set()
    for (const op of ops) {
      if (stopped.has(op.a)) continue
      if (!isStub(op)) { out.push(op); continue }
      const proof = (g.byAuthor.get(op.a) || [])[op.by - 1]
      if (!stubs || !proof || isStub(proof)) { stopped.add(op.a); continue }
      out.push({ g: op.g, a: op.a, s: op.s, t: op.t, k: STUB, d: {}, sig: '', by: op.by, ok: op.ok, oid: op.oid })
      const id = op.a + ':' + op.by
      if (!inBatch.has(id) && !added.has(id)) { added.add(id); proofs.push(proof) }
    }
    return { ops: out, proofs }
  }

  // Check a stub received from a peer against the op that supersedes it
  _validStub (groupId, op, proofs, batch) {
    if (!Number.isInteger(op.by) || op.by <= op.s) return false
    const proof = batch.find(x => x.a === op.a && x.s === op.by && !isStub(x)) ||
      (Array.isArray(proofs) ? proofs.find(x => x && x.a === op.a && x.s === op.by) : null)
    if (!proof || proof.g !== groupId || !SUPERSEDES[proof.k] || !proof.d || !Array.isArray(proof.d.sup) || !proof.d.sup.includes(op.s)) return false
    if (Buffer.byteLength(JSON.stringify(proof)) > MAX_OP_BYTES + 256) return false
    return c.verifyOp(proof)
  }

  _setEpochs (g) {
    g.epoch = Math.max(...g.epochs.keys())
    g.secret = g.epochs.get(g.epoch)
    g.topic = c.topicFromSecret(g.secret)
    // Old topics stay announced so members who were offline during a kick can still find us
    // and pick up the new key.
    g.topics = [...g.epochs.values()].map(s => c.topicFromSecret(s))
  }

  _metaOf (g) {
    const epochs = {}
    for (const [e, s] of g.epochs) epochs[e] = s.toString('hex')
    return {
      id: g.id,
      secret: g.epochs.get(Math.min(...g.epochs.keys())).toString('hex'),
      epochs,
      owner: g.owner,
      dm: g.dm || undefined,
      nameHint: g.nameHint,
      joinedAt: g.joinedAt
    }
  }

  _saveMeta (g) {
    const meta = this._metaOf(g)
    if (g.restoring) meta.restoring = true
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
      epoch: g.epoch,
      restoring: !!g.restoring
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

  setProfile ({ name, color, avatar, claude }) {
    if (typeof name === 'string') this.identity.name = name.trim().slice(0, 32)
    // "Claude may read my messages when friends ask it something" (off by default)
    if (claude === true) this.identity.claude = true
    else if (claude === false) delete this.identity.claude
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
    if (this.identity.claude) d.claude = true
    return d
  }

  publicIdentity () {
    return { key: this.myKey, name: this.identity.name, color: this.identity.color, avatar: this.identity.avatar || null, claude: !!this.identity.claude, sealed: this.sealed }
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

  // Old reusable OD1 codes (from before 0.4). Returns { group, existed, rekeyed }.
  joinGroup (invite) {
    return this._joinWithSecret(c.parseInvite(invite))
  }

  // Joining a group you're already in with a newer key (e.g. after being kicked and
  // re-invited) just adds the new key.
  _joinWithSecret ({ secret, name, id, epoch, owner }) {
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

  // ---- one-time invites (see crypto.js "one-time links") ----

  _isMod (g, key) { return key === g.owner || g.admins.has(key) }

  // The newest 'group.settings' from the owner or an admin wins
  groupSettings (g) {
    const out = { invites: 'all' }
    let best = null
    for (const op of g.ops) {
      if (op.k !== 'group.settings' || !this._isMod(g, op.a)) continue
      if ((op.d.invites === 'admins' || op.d.invites === 'all') && (!best || timeOrder(op, best) > 0)) { best = op; out.invites = op.d.invites }
    }
    return out
  }

  canInvite (g, key = this.myKey) {
    return !!g && !g.dm && !g.kickedMe && (this.groupSettings(g).invites !== 'admins' || this._isMod(g, key))
  }

  invitesOf (g) {
    const map = new Map()
    const rest = []
    for (const op of g.ops) {
      if (op.k === 'invite.create') {
        const d = op.d
        if (isHex(d.id, 32) && isHex(d.topic, 64) && isHex(d.k, 64) && !map.has(d.id)) {
          map.set(d.id, { id: d.id, topic: d.topic, k: d.k, exp: Number.isFinite(d.exp) ? d.exp : 0, by: op.a, t: op.t, used: null, revoked: false })
        }
      } else if (op.k === 'invite.used' || op.k === 'invite.revoke') rest.push(op)
    }
    for (const op of rest.sort(timeOrder)) {
      const inv = map.get(op.d.id)
      if (!inv) continue
      if (op.k === 'invite.used' && isKey(op.d.key) && !inv.used) inv.used = { key: op.d.key, by: op.a, t: op.t }
      if (op.k === 'invite.revoke' && (op.a === inv.by || this._isMod(g, op.a))) inv.revoked = true
    }
    return map
  }

  // Invites that can still be used. Members wait for their guests on these topics.
  activeInvites (g) {
    if (g.dm || g.kickedMe) return []
    const now = Date.now()
    const adminsOnly = this.groupSettings(g).invites === 'admins'
    return [...this.invitesOf(g).values()].filter(i => !i.used && !i.revoked && (!i.exp || i.exp > now) && (!adminsOnly || this._isMod(g, i.by)))
  }

  createInvite (groupId, ttl = 7 * 864e5) {
    const g = this.groups.get(groupId)
    if (!g) throw new Error('Unknown group')
    if (g.dm) throw new Error("Private chats can't have invites")
    if (!this.canInvite(g)) throw new Error('Only the owner and admins can invite people to this group')
    const token = c.randomBytes(32)
    const keys = c.linkKeys(token)
    const exp = ttl > 0 ? Date.now() + ttl : 0
    const op = this.append(groupId, 'invite.create', { id: keys.id, topic: keys.topic.toString('hex'), k: keys.key.toString('hex'), exp })
    return { op, link: c.makeJoinLink({ token, gid: g.id, inviter: this.myKey, exp, name: this.groupName(g) }) }
  }

  // Someone on this connection proves they hold the token for invite `id`. A valid, unused
  // invite is marked used (the returned op must be broadcast) and they may get the key.
  redeem (peerKey, id, proof, handshakeHash) {
    if (!isHex(id, 32) || typeof proof !== 'string') return { reason: 'unknown' }
    for (const g of this.groups.values()) {
      if (g.dm || g.kickedMe) continue
      const inv = this.invitesOf(g).get(id)
      if (!inv) continue
      const expect = c.redeemProof(Buffer.from(inv.k, 'hex'), handshakeHash, Buffer.from(peerKey, 'hex'))
      if (!c.safeEqualHex(proof, expect)) return { reason: 'denied' }
      if (inv.used) return inv.used.key === peerKey ? { group: g, op: null } : { reason: 'used' }
      if (inv.revoked || (this.groupSettings(g).invites === 'admins' && !this._isMod(g, inv.by))) return { reason: 'revoked' }
      if (inv.exp && inv.exp < Date.now()) return { reason: 'expired' }
      return { group: g, op: this.append(g.id, 'invite.used', { id, key: peerKey }) }
    }
    return { reason: 'unknown' }
  }

  // The group key for a new member, sealed to their identity key
  admitBox (g, peerKey) {
    const body = { s: g.secret.toString('hex'), e: g.epoch, o: g.owner, i: g.id, n: this.groupName(g) }
    return c.sealTo(peerKey, Buffer.from(JSON.stringify(body)))
  }

  // ---- joining with a one-time link (the guest's side) ----
  // Pending joins survive restarts (joins.json) until a member lets us in or says no.

  _saveJoins () { writeJSONAtomic(path.join(this.dir, 'joins.json'), this.joins) }

  startJoin (link) {
    const p = c.parseLink(link)
    if (!p || p.kind !== 'join') throw new Error('Not an OpenDiscord invite link')
    if (p.exp && p.exp < Date.now()) throw new Error('This invite link has expired. Ask for a new one.')
    if (p.inviter === this.myKey) throw new Error("That's an invite you made. Send it to a friend!")
    const existing = this.groups.get(p.gid)
    if (existing && !existing.kickedMe) return { group: existing }
    const keys = c.linkKeys(p.token)
    const j = { id: keys.id, token: p.token.toString('hex'), gid: p.gid, inviter: p.inviter, exp: p.exp, name: p.name, at: Date.now() }
    this.joins[keys.id] = j
    this._saveJoins()
    return { join: j }
  }

  joinKeys (j) {
    const keys = c.linkKeys(Buffer.from(j.token, 'hex'))
    return { key: keys.key, topic: keys.topic }
  }

  dropJoin (id) {
    if (!this.joins[id]) return false
    delete this.joins[id]
    this._saveJoins()
    return true
  }

  joinsInfo () { return Object.values(this.joins).map(({ id, gid, name, at, exp }) => ({ id, gid, name, at, exp })) }

  // A member let us in: open the sealed group key and join
  admitted (id, box) {
    const j = this.joins[id]
    if (!j) return null
    const plain = c.openSealed(this.keyPair, box)
    if (!plain) return null
    let b
    try { b = JSON.parse(plain.toString('utf8')) } catch { return null }
    if (!isHex(b.s, 64) || b.i !== j.gid || !Number.isInteger(b.e) || b.e < 0) return null
    const res = this._joinWithSecret({ secret: Buffer.from(b.s, 'hex'), name: String(b.n || j.name || '').slice(0, 100), id: b.i, epoch: b.e, owner: isKey(b.o) ? b.o : null })
    this.dropJoin(id)
    return res
  }

  // ---- friends & private chats ----
  //
  // A friendship is a private chat "group" whose secret comes from a key exchange between the
  // two identity keys (crypto.dmSecret). Friend requests are delivered directly from app to app
  // (network.sendFriendRequest); pending ones live in friends.json.

  _friendsFile () { return path.join(this.dir, 'friends.json') }
  _loadFriends () {
    const f = readJSON(this._friendsFile(), null) || {}
    this.friends = { incoming: f.incoming || {}, outgoing: f.outgoing || {}, links: f.links || {} }
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
    else if (!this.isFriend(parsed.key)) {
      // A one-time friend link: its token makes the request accepted on arrival
      this.friends.outgoing[parsed.key] = { name: label, at: Date.now(), tok: parsed.token ? parsed.token.toString('hex') : undefined }
    }
    this._saveFriends()
    return { group: g, key: parsed.key }
  }

  friendToken (key) {
    const t = this.friends.outgoing[key]?.tok
    return isHex(t, 64) ? Buffer.from(t, 'hex') : null
  }

  // ---- one-time friend links ----

  createFriendLink (ttl = 7 * 864e5) {
    const token = c.randomBytes(32)
    const keys = c.linkKeys(token)
    const now = Date.now()
    for (const [id, l] of Object.entries(this.friends.links)) {
      if ((l.used && now - l.used.at > 30 * 864e5) || (l.exp && now - l.exp > 30 * 864e5)) delete this.friends.links[id]
    }
    this.friends.links[keys.id] = { k: keys.key.toString('hex'), at: now, exp: ttl > 0 ? now + ttl : 0, used: null }
    this._saveFriends()
    return c.makeFriendLink({ key: this.myKey, token, name: this.identity.name })
  }

  friendLinksInfo () {
    const now = Date.now()
    return Object.entries(this.friends.links)
      .filter(([, l]) => !l.used && (!l.exp || l.exp > now))
      .map(([id, l]) => ({ id, at: l.at, exp: l.exp }))
      .sort((a, b) => b.at - a.at)
  }

  revokeFriendLink (id) {
    delete this.friends.links[id]
    this._saveFriends()
  }

  // A friend request that came with a link proof. Returns 'accept' | 'used' | 'expired' | 'invalid'.
  checkFriendLink (peerKey, id, proof, handshakeHash) {
    const l = this.friends.links[id]
    if (!l || typeof proof !== 'string') return 'invalid'
    if (!c.safeEqualHex(proof, c.redeemProof(Buffer.from(l.k, 'hex'), handshakeHash, Buffer.from(peerKey, 'hex')))) return 'invalid'
    if (l.used) return l.used.key === peerKey ? 'accept' : 'used'
    if (l.exp && l.exp < Date.now()) return 'expired'
    l.used = { key: peerKey, at: Date.now() }
    this._saveFriends()
    return 'accept'
  }

  // They opened our friend link: friends right away, no request to accept
  acceptFromLink (key, { name } = {}) {
    delete this.friends.incoming[key]
    const g = this.openDm(key, String(name || '').slice(0, 32))
    this._saveFriends()
    return g
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
    for (const key of this.pendingOutgoing()) {
      const { tok, ...r } = this.friends.outgoing[key]
      out.outgoing.push({ key, ...r, link: !!tok })
    }
    out.links = this.friendLinksInfo()
    return out
  }

  // ---- ops ----

  append (groupId, kind, data) {
    const g = this.groups.get(groupId)
    if (!g) throw new Error('Unknown group')
    if (kind === STUB) throw new Error('Reserved op kind')
    if (g.restoring) {
      const err = new Error('Still getting your messages back from your friends. You can post here once someone from this chat has been online.')
      err.code = 'RESTORING'
      throw err
    }
    const mine = g.byAuthor.get(this.myKey) || []
    const d = data && typeof data === 'object' ? data : {}
    delete d.sup
    const sup = this._supFor(g, kind, d)
    if (sup) d.sup = sup
    const op = { g: groupId, a: this.myKey, s: mine.length + 1, t: Date.now(), k: String(kind), d }
    if (Buffer.byteLength(JSON.stringify(op)) > MAX_OP_BYTES) throw new Error('Message too large')
    op.sig = c.signOp(op, this.keyPair.secretKey)
    mine.push(op)
    g.byAuthor.set(this.myKey, mine)
    g.ops.push(op)
    this._persist(g, [op])
    if (sup) this._applySup(g, op)
    if (MEMBERSHIP_KINDS.has(op.k)) this._recomputeMembership(g)
    return op
  }

  // Validate and store ops received from a peer. Returns newly accepted ops and whether
  // a gap was detected (we got seq N+2 before N+1), in which case the caller re-syncs.
  // `proofs`: ops that vouch for stubs in this batch (see wire)
  ingest (groupId, ops, proofs = null) {
    const g = this.groups.get(groupId)
    const result = { accepted: [], gap: false, membership: false }
    if (!g || !Array.isArray(ops)) return result
    const valid = ops.filter(op => op && typeof op === 'object' && op.g === groupId &&
      typeof op.a === 'string' && op.a.length === 64 &&
      Number.isInteger(op.s) && op.s > 0 && typeof op.t === 'number' &&
      typeof op.k === 'string' && op.k.length <= 32 && op.d && typeof op.d === 'object' &&
      typeof op.sig === 'string')
    valid.sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : x.s - y.s)
    for (const op of valid) {
      const list = g.byAuthor.get(op.a) || []
      if (op.s <= list.length) continue // already have it
      if (op.s > list.length + 1) { result.gap = true; continue }
      let clean
      if (isStub(op)) {
        if (!this._validStub(groupId, op, proofs, valid)) continue
        const s32 = (v) => typeof v === 'string' ? v.slice(0, 32) : undefined
        clean = { g: groupId, a: op.a, s: op.s, t: op.t, k: STUB, d: {}, sig: '', by: op.by, ok: s32(op.ok), oid: s32(op.oid) }
      } else {
        if (Buffer.byteLength(JSON.stringify(op)) > MAX_OP_BYTES + 256) continue
        if (!c.verifyOp(op)) continue
        clean = { g: op.g, a: op.a, s: op.s, t: op.t, k: op.k, d: op.d, sig: op.sig }
      }
      list.push(clean)
      g.byAuthor.set(op.a, list)
      g.ops.push(clean)
      result.accepted.push(clean)
    }
    if (result.accepted.length) {
      this._persist(g, result.accepted)
      for (const op of result.accepted) if (Array.isArray(op.d.sup)) this._applySup(g, op)
      if (result.accepted.some(op => MEMBERSHIP_KINDS.has(op.k))) result.membership = this._recomputeMembership(g)
      result.restored = this._checkRestored(g)
    }
    return result
  }

  vector (groupId) {
    const g = this.groups.get(groupId)
    const vec = {}
    if (g) for (const [a, list] of g.byAuthor) vec[a] = list.length
    return vec
  }

  // stubs: false for peers from before 0.4 (they get each author's ops up to the first stub)
  opsMissingFrom (groupId, theirVec, { stubs = true } = {}) {
    const g = this.groups.get(groupId)
    const out = []
    if (!g) return out
    for (const [a, list] of g.byAuthor) {
      const have = Number(theirVec?.[a]) || 0
      if (have >= list.length) continue
      let part = list.slice(have)
      if (!stubs) {
        const i = part.findIndex(isStub)
        if (i >= 0) part = part.slice(0, i)
      }
      out.push(...part)
    }
    return out
  }

  // ---- storage usage ----

  messageUsage () {
    let disk = 0
    let raw = 0
    let ops = 0
    let stubs = 0
    for (const g of this.groups.values()) {
      for (const s of g.segs) { disk += s.bytes; raw += s.raw }
      disk += g.hotBytes
      raw += g.hotBytes
      ops += g.ops.length
      for (const op of g.ops) if (isStub(op)) stubs++
    }
    return { disk, raw, ops, stubs }
  }

  // Files still referenced by a message, and whether you sent them
  _blobRefs () {
    const refs = new Map() // hash -> { mine }
    for (const g of this.groups.values()) {
      const deleted = new Set()
      for (const op of g.ops) if (op.k === 'msg.delete' && typeof op.d.id === 'string') deleted.add(op.a + ':' + op.d.id)
      for (const op of g.ops) {
        if (op.k !== 'msg' || !Array.isArray(op.d.att) || deleted.has(op.a + ':' + op.d.id)) continue
        for (const a of op.d.att) {
          if (!a || !isHex(a.h, 64)) continue
          const r = refs.get(a.h) || { mine: false }
          if (op.a === this.myKey) r.mine = true
          refs.set(a.h, r)
        }
      }
    }
    return refs
  }

  async _eachBlob (fn) {
    for (const f of await fs.promises.readdir(this.blobsDir).catch(() => [])) {
      if (!/^[0-9a-f]{64}$/.test(f)) continue
      const file = path.join(this.blobsDir, f)
      let st
      try { st = await fs.promises.stat(file) } catch { continue }
      await fn(f, file, st)
    }
  }

  async blobUsage () {
    const refs = this._blobRefs()
    const out = { mine: { n: 0, bytes: 0 }, friends: { n: 0, bytes: 0 }, unused: { n: 0, bytes: 0 } }
    await this._eachBlob((h, _file, st) => {
      const r = refs.get(h)
      const b = !r ? out.unused : r.mine ? out.mine : out.friends
      b.n++
      b.bytes += st.size
    })
    return out
  }

  // Deletes files from deleted messages, and (friends: true) files friends sent that are older
  // than `days` (0 = all of them). Files you sent always stay.
  async cleanBlobs ({ days = 0, friends = true } = {}) {
    const refs = this._blobRefs()
    const now = Date.now()
    const out = { n: 0, bytes: 0 }
    await this._eachBlob(async (h, file, st) => {
      const r = refs.get(h)
      const age = now - st.mtimeMs
      // nothing refers to it: wait a day, it may be an attachment that's about to be sent
      const drop = !r ? age > 864e5 : friends && !r.mine && age >= days * 864e5
      if (!drop) return
      try { await fs.promises.unlink(file); out.n++; out.bytes += st.size } catch {}
    })
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
