'use strict'
// Peer-to-peer networking on Hyperswarm.
//
// Discovery: every group announces sha256(secret) on the HyperDHT (a public Kademlia DHT
// whose nodes are just other peers). Hyperswarm then UDP hole-punches a direct connection
// and encrypts it with Noise (XX pattern, ed25519 static keys) + libsodium secretstream.
// No relay is configured, so bytes only ever flow directly between friends.
//
// Authorization: being connected is not enough — each side must prove it knows the group
// secret with an HMAC bound to this connection's Noise handshake hash.
//
// One-time invites (0.4): members wait on each unused invite's topic. A guest connects there
// (or straight to the inviter), proves they hold the link's token ('redeem'), and a member who
// finds the invite unused records invite.used and replies 'admit' with the group key sealed to
// the guest. From then on the guest is an ordinary member.
const fs = require('fs')
const os = require('os')
const dgram = require('dgram')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const Hyperswarm = require('hyperswarm')
const c = require('./crypto')
const { encodeJSON, encodeBlobChunk, FrameParser } = require('./framing')

// 2 (0.4): stubs in sync, one-time invites and friend links
const PROTOCOL_VERSION = 2
const SYNC_BATCH_BYTES = 1024 * 1024
const BLOB_CHUNK = 64 * 1024
const BLOB_IDLE_TIMEOUT = 30000

// Interface names used by common VPN clients (Windows shows the connection name, e.g. "ProTUN").
const VPN_IFACE = /(vpn|wireguard|proton|protun|nord|mullvad|surfshark|cyberghost|windscribe|ipvanish|openvpn|tailscale|zerotier|\btun\d*\b|\btap\b|\bwg\d*\b|\butun\d*\b)/i

// Which local interface carries internet traffic? A UDP "connect" picks the route without
// sending any packet. If that interface is a VPN, P2P traffic goes through the VPN server.
function defaultRoute () {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.close() } catch {}
      resolve(v)
    }
    sock.on('error', () => finish(null))
    setTimeout(() => finish(null), 1000)
    try {
      sock.connect(53, '1.1.1.1', () => {
        let address = null
        try { address = sock.address().address } catch { return finish(null) }
        let iface = null
        for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
          if ((addrs || []).some(a => a.address === address)) iface = name
        }
        finish({ address, iface, vpn: VPN_IFACE.test(iface || '') })
      })
    } catch { finish(null) }
  })
}

function isLanAddress (host) {
  if (!host) return false
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(host)) return true
  const m = /^172\.(\d+)\./.exec(host)
  if (m && +m[1] >= 16 && +m[1] <= 31) return true
  const h = host.toLowerCase()
  return h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h === '::1'
}

class Network extends EventEmitter {
  constructor (store, opts = {}) {
    super()
    this.store = store
    this.bootstrap = opts.bootstrap
    this.authTimeout = opts.authTimeout || 30000
    this.lonelyInterval = opts.lonelyInterval || 60000
    this.appVersion = typeof opts.appVersion === 'string' ? opts.appVersion : null
    this.peers = new Map() // remoteKeyHex -> peer
    this.incoming = new Map() // `${peerKey}:${id}` -> transfer
    this.inflight = new Map() // hash -> Promise<path>
    this.nextTransferId = 1
    this.started = false
    this.discoveries = new Map() // groupId -> Map(topicHex -> hyperswarm discovery session)
    this.failures = new Map() // remoteKeyHex -> { code, message, at, count }
    this.friendQueue = new Set() // keys we owe a friend request until they confirm receipt
    this.inviteTopics = new Map() // topicHex -> discovery: unused invites of our groups
    this.joining = new Map() // inviteId -> { topic, key, inviter, discovery }: links we're redeeming
  }

  async start () {
    this.swarm = new Hyperswarm({ keyPair: this.store.keyPair, bootstrap: this.bootstrap })
    this.swarm.on('connection', (conn, info) => this._onConnection(conn, info))
    // Hyperswarm silently retries failed connections; record *why* they fail
    // (e.g. HOLEPUNCH_DOUBLE_RANDOMIZED_NATS) so the UI can explain it.
    const dht = this.swarm.dht
    const connect = dht.connect.bind(dht)
    dht.connect = (publicKey, opts) => {
      const stream = connect(publicKey, opts)
      const key = Buffer.from(publicKey).toString('hex')
      stream.on('error', (err) => {
        const prev = this.failures.get(key)
        this.failures.set(key, { code: err.code || 'ERROR', message: err.message, at: Date.now(), count: (prev?.count || 0) + 1 })
      })
      stream.on('open', () => this.failures.delete(key))
      return stream
    }
    // Always reachable by our public key, even without groups, so friend requests can be
    // delivered. Only someone who already has our friend code (or shares a group) knows the key.
    await this.swarm.listen().catch((err) => console.warn('[net] listen', err.message))
    for (const g of this.store.groups.values()) this._join(g)
    for (const key of this.store.pendingOutgoing()) this.sendFriendRequest(key)
    this.refreshInvites()
    for (const j of Object.values(this.store.joins)) this.startJoin(j)
    // Hyperswarm only re-runs lookups every ~10 min, and stops retrying a peer after a few
    // failed hole punches. While a group has nobody connected, look again every minute so a
    // friend who just came online (or fixed their network) is found quickly.
    this.lonelyTimer = setInterval(() => this._refreshLonely(), this.lonelyInterval)
    this.lonelyTimer.unref?.()
    this.started = true
  }

  _refreshLonely () {
    for (const [gid, ds] of this.discoveries) {
      if (this.peersIn(gid).length === 0) for (const d of ds.values()) d.refresh().catch(() => {})
    }
    // Friend requests that haven't arrived yet: dial again (the friend may have come online)
    for (const key of this.friendQueue) {
      if (this.peers.has(key)) continue
      const pk = Buffer.from(key, 'hex')
      try { this.swarm.leavePeer(pk) } catch {}
      this.swarm.joinPeer(pk)
    }
    // Invites expire; and a pending join keeps looking for a member who is online
    this.refreshInvites()
    for (const j of this.joining.values()) {
      j.discovery?.refresh().catch(() => {})
      if (!this.peers.has(j.inviter)) {
        const pk = Buffer.from(j.inviter, 'hex')
        try { this.swarm.leavePeer(pk) } catch {}
        this.swarm.joinPeer(pk)
      }
    }
  }

  // ---- one-time invites ----

  // Wait on the topic of every unused invite in our groups, leave the others
  refreshInvites () {
    if (!this.swarm) return
    const want = new Set()
    for (const g of this.store.groups.values()) for (const inv of this.store.activeInvites(g)) want.add(inv.topic)
    for (const [hex] of this.inviteTopics) {
      if (want.has(hex)) continue
      this.inviteTopics.delete(hex)
      this.swarm.leave(Buffer.from(hex, 'hex')).catch(() => {})
    }
    for (const hex of want) {
      if (!this.inviteTopics.has(hex)) this.inviteTopics.set(hex, this.swarm.join(Buffer.from(hex, 'hex'), { server: true, client: false }))
    }
  }

  // Guest side: look for members on the invite topic and ring the inviter directly
  startJoin (j) {
    if (this.joining.has(j.id)) return
    if (j.exp && j.exp < Date.now()) {
      this.store.dropJoin(j.id)
      this.emit('join-failed', j.id, 'expired', j)
      return
    }
    const { key, topic } = this.store.joinKeys(j)
    const entry = { id: j.id, key, topic, inviter: j.inviter, gid: j.gid, name: j.name }
    this.joining.set(j.id, entry)
    entry.discovery = this.swarm.join(topic, { server: false, client: true })
    if (j.inviter !== this.store.myKey) this.swarm.joinPeer(Buffer.from(j.inviter, 'hex'))
    for (const peer of this.peers.values()) if (peer.proto >= 2) this._sendRedeem(peer, entry)
  }

  cancelJoin (id) {
    const j = this.joining.get(id)
    if (!j) return
    this.joining.delete(id)
    this.swarm.leave(j.topic).catch(() => {})
    if (!this.friendQueue.has(j.inviter)) {
      try { this.swarm.leavePeer(Buffer.from(j.inviter, 'hex')) } catch {}
    }
  }

  _sendRedeem (peer, j) {
    this._send(peer, { t: 'redeem', id: j.id, proof: c.redeemProof(j.key, peer.hh, this.store.keyPair.publicKey) })
  }

  // Announce every key epoch's topic: the current one for everyone, older ones so members who
  // missed a kick can still find us and pick up the new key.
  _join (group) {
    const ds = this.discoveries.get(group.id) || new Map()
    for (const topic of group.topics) {
      const hex = topic.toString('hex')
      if (!ds.has(hex)) ds.set(hex, this.swarm.join(topic, { server: true, client: true }))
    }
    this.discoveries.set(group.id, ds)
  }

  // Called after a kick, a role change or a new key arrived: re-announce, re-prove membership,
  // and re-check everyone who is connected (a kicked peer loses access right here).
  membershipChanged (groupId) {
    const g = this.store.groups.get(groupId)
    if (!g) return
    this._join(g)
    for (const peer of [...this.peers.values()]) {
      const had = peer.groups.size > 0
      this._send(peer, { t: 'auth', tags: this._myTags(peer) })
      this._evaluate(peer)
      if (had && !peer.groups.size) this._dropPeer(peer, true)
    }
  }

  // Look the group topics up again right now instead of waiting for the periodic refresh
  // (Hyperswarm backs off for minutes after a few failed attempts).
  async retry () {
    this.failures.clear()
    await Promise.allSettled([...this.discoveries.values()].flatMap(ds => [...ds.values()].map(d => d.refresh())))
  }

  async diagnostics () {
    const dht = this.swarm?.dht
    const route = await defaultRoute()
    const groups = {}
    for (const g of this.store.groups.values()) {
      const topics = new Set(g.topics.map(t => t.toString('hex')))
      const found = []
      for (const [key, info] of this.swarm?.peers || []) {
        if ((info.topics || []).some(t => topics.has(Buffer.from(t).toString('hex')))) found.push(key)
      }
      const connected = this.peersIn(g.id).map(p => p.key)
      groups[g.id] = {
        found: new Set([...found, ...connected]).size,
        connected: connected.length,
        failures: found.filter(k => !connected.includes(k) && this.failures.has(k)).map(k => ({ peer: k.slice(0, 8), ...this.failures.get(k) }))
      }
    }
    return {
      dht: {
        online: !!dht && !dht.destroyed && dht.bootstrapped,
        firewalled: dht ? dht.firewalled : null,
        randomized: dht ? dht.randomized : null,
        natKnown: !!(dht && dht.host)
      },
      route,
      connecting: this.swarm?.connecting || 0,
      groups
    }
  }

  async stop () {
    clearInterval(this.lonelyTimer)
    if (!this.swarm) return
    for (const p of this.peers.values()) this._cleanupPeer(p)
    await this.swarm.destroy()
  }

  // ---- groups ----

  joinGroup (group) {
    this._join(group)
    // Prove membership first: _evaluate may send 'sync', which the peer ignores until it has
    // seen our tags (matters when we were already connected, e.g. a guest who was just let in)
    for (const peer of this.peers.values()) {
      this._send(peer, { t: 'auth', tags: this._myTags(peer) })
      this._evaluate(peer)
    }
  }

  leaveGroup (group) {
    this.discoveries.delete(group.id)
    for (const topic of group.topics) this.swarm.leave(topic).catch(() => {})
    for (const peer of this.peers.values()) {
      if (peer.groups.delete(group.id)) this.emit('peer-leave', group.id, peer.key)
      this._send(peer, { t: 'auth', tags: this._myTags(peer) })
    }
  }

  // ---- friend requests ----
  // Delivered app-to-app: Hyperswarm can dial a peer directly by its public key, which is the
  // same key as the friend's identity. Retried until the friend's app confirms receipt.

  sendFriendRequest (key) {
    if (!/^[0-9a-f]{64}$/.test(key) || key === this.store.myKey) return
    this.friendQueue.add(key)
    const peer = this.peers.get(key)
    if (peer) this._sendFriend(peer)
    else this.swarm.joinPeer(Buffer.from(key, 'hex'))
  }

  cancelFriendRequest (key) {
    this.friendQueue.delete(key)
    try { this.swarm.leavePeer(Buffer.from(key, 'hex')) } catch {}
  }

  _sendFriend (peer) {
    const me = this.store.identity
    const msg = { t: 'friend', name: me.name, color: me.color }
    // Opened their one-time friend link: prove it, so they accept us right away
    const tok = this.store.friendToken(peer.key)
    if (tok) {
      const keys = c.linkKeys(tok)
      msg.inv = keys.id
      msg.proof = c.redeemProof(keys.key, peer.hh, this.store.keyPair.publicKey)
    }
    this._send(peer, msg)
  }

  // ---- sending ----

  _send (peer, msg) {
    if (peer.conn.destroyed) return false
    return peer.conn.write(encodeJSON(msg))
  }

  peersIn (groupId) {
    return [...this.peers.values()].filter(p => p.groups.has(groupId))
  }

  broadcastOps (groupId, ops, exceptKey = null) {
    for (const p of this.peersIn(groupId)) {
      if (p.key === exceptKey) continue
      const w = this.store.wire(groupId, ops, { stubs: p.proto >= 2 })
      if (w.ops.length) this._send(p, { t: 'ops', g: groupId, ops: w.ops, proofs: w.proofs.length ? w.proofs : undefined })
    }
  }

  sendEphemeral (groupId, to, data) {
    for (const p of this.peersIn(groupId)) {
      if (!to || p.key === to) this._send(p, { t: 'eph', g: groupId, d: data })
    }
  }

  peerInfo (peer) {
    return {
      key: peer.key,
      rtt: peer.rtt,
      host: peer.host,
      family: peer.family,
      lan: isLanAddress(peer.host),
      version: peer.appVersion || null,
      groups: [...peer.groups],
      since: peer.connectedAt
    }
  }

  onlinePeers () {
    return [...this.peers.values()].filter(p => p.groups.size).map(p => this.peerInfo(p))
  }

  // ---- connection lifecycle ----

  _onConnection (conn) {
    const key = conn.remotePublicKey.toString('hex')
    if (!conn.handshakeHash) { conn.destroy(); return }
    const existing = this.peers.get(key)
    if (existing) this._dropPeer(existing)

    const raw = conn.rawStream || {}
    const peer = {
      key,
      remoteKey: conn.remotePublicKey,
      conn,
      hh: conn.handshakeHash,
      groups: new Set(),
      remoteTags: new Set(),
      proto: 0, // their protocol version, from hello
      host: raw.remoteHost,
      family: raw.remoteFamily,
      rtt: null,
      connectedAt: Date.now(),
      lastGapSync: new Map(),
      serving: new Set()
    }
    peer.parser = new FrameParser((f) => {
      if (f.kind === 'json') this._onMessage(peer, f.msg)
      else this._onBlobChunk(peer, f.id, f.data)
    })
    conn.on('data', (d) => {
      try { peer.parser.push(d) } catch (err) { conn.destroy(err) }
    })
    conn.on('error', () => {})
    conn.on('close', () => this._dropPeer(peer))
    this.peers.set(key, peer)

    this._send(peer, { t: 'hello', v: PROTOCOL_VERSION, app: this.appVersion, tags: this._myTags(peer) })
    if (this.friendQueue.has(key)) this._sendFriend(peer)
    peer.authTimer = setTimeout(() => { if (!peer.groups.size) conn.destroy() }, this.authTimeout)
    peer.pingTimer = setInterval(() => this._send(peer, { t: 'ping', ts: Date.now() }), 5000)
  }

  _cleanupPeer (peer) {
    clearTimeout(peer.authTimer)
    clearInterval(peer.pingTimer)
    for (const rs of peer.serving) rs.destroy()
    peer.serving.clear()
    for (const [id, tr] of this.incoming) {
      if (tr.peer === peer) { this.incoming.delete(id); tr.fail(new Error('Peer disconnected')) }
    }
  }

  // graceful: flush what we already wrote (e.g. the kick op) before closing
  _dropPeer (peer, graceful = false) {
    if (this.peers.get(peer.key) !== peer) return
    this.peers.delete(peer.key)
    this._cleanupPeer(peer)
    for (const g of peer.groups) this.emit('peer-leave', g, peer.key)
    peer.groups.clear()
    if (peer.conn.destroyed) return
    if (!graceful) return peer.conn.destroy()
    peer.conn.end()
    setTimeout(() => { if (!peer.conn.destroyed) peer.conn.destroy() }, 3000).unref?.()
  }

  // One membership proof per group and key epoch. The receiver can't tell which group a tag
  // belongs to unless it's in that group too.
  _myTags (peer) {
    const tags = []
    for (const g of this.store.groups.values()) {
      for (const secret of g.epochs.values()) tags.push(c.authTag(secret, peer.hh, this.store.keyPair.publicKey))
    }
    return tags
  }

  _evaluate (peer) {
    for (const g of this.store.groups.values()) {
      let epoch = -1
      for (const [e, secret] of g.epochs) {
        if (e > epoch && peer.remoteTags.has(c.authTag(secret, peer.hh, peer.remoteKey))) epoch = e
      }
      const ok = epoch >= 0 && this.store.authorize(g, peer.key, epoch)
      if (ok && !peer.groups.has(g.id)) {
        peer.groups.add(g.id)
        this.emit('peer-join', g.id, peer.key, this.peerInfo(peer))
        this._send(peer, { t: 'sync', g: g.id, vec: this.store.vector(g.id) })
      } else if (!ok && peer.groups.has(g.id)) {
        peer.groups.delete(g.id)
        this.emit('peer-leave', g.id, peer.key)
      }
    }
  }

  // ---- inbound ----

  _onMessage (peer, msg) {
    if (!msg || typeof msg.t !== 'string') return
    try {
      switch (msg.t) {
        case 'hello':
        case 'auth':
          if (msg.t === 'hello') {
            if (typeof msg.app === 'string' && /^\d+\.\d+\.\d+[\w.-]{0,20}$/.test(msg.app)) peer.appVersion = msg.app
            peer.proto = Number.isInteger(msg.v) ? msg.v : 1
            if (peer.proto >= 2) for (const j of this.joining.values()) this._sendRedeem(peer, j)
          }
          if (!Array.isArray(msg.tags)) return
          peer.remoteTags = new Set(msg.tags.slice(0, 512).filter(t => typeof t === 'string'))
          this._evaluate(peer)
          return
        case 'ping':
          this._send(peer, { t: 'pong', ts: msg.ts })
          return
        case 'friend': { // may come from someone we share nothing with yet
          if (typeof msg.inv === 'string') {
            const r = this.store.checkFriendLink(peer.key, msg.inv, msg.proof, peer.hh)
            if (r !== 'accept') { this._send(peer, { t: 'friend.no', reason: r }); return }
            const g = this.store.acceptFromLink(peer.key, { name: msg.name })
            this._send(peer, { t: 'friend.ok' })
            this.joinGroup(g)
            this.emit('friend-linked', peer.key, g)
            return
          }
          if (this.store.receiveFriendRequest(peer.key, { name: msg.name, color: msg.color })) this.emit('friend-request', peer.key)
          this._send(peer, { t: 'friend.ok' })
          return
        }
        case 'friend.ok':
          this.cancelFriendRequest(peer.key)
          return
        case 'friend.no':
          if (!this.friendQueue.has(peer.key)) return
          this.cancelFriendRequest(peer.key)
          this.emit('friend-rejected', peer.key, ['used', 'expired'].includes(msg.reason) ? msg.reason : 'invalid')
          return
        case 'redeem': { // a guest with a one-time invite; not a member (yet)
          const r = this.store.redeem(peer.key, msg.id, msg.proof, peer.hh)
          if (r.reason) {
            if (r.reason !== 'unknown') this._send(peer, { t: 'redeem.no', id: msg.id, reason: r.reason })
            return
          }
          if (r.op) {
            this.broadcastOps(r.group.id, [r.op])
            this.emit('ops', r.group.id, [r.op])
            this.refreshInvites()
          }
          this._send(peer, { t: 'admit', id: msg.id, box: this.store.admitBox(r.group, peer.key) })
          return
        }
        case 'admit': {
          if (!this.joining.has(msg.id)) return
          const res = this.store.admitted(msg.id, msg.box)
          if (!res) return
          this.cancelJoin(msg.id)
          this.joinGroup(res.group)
          this.emit('joined', msg.id, res)
          return
        }
        case 'redeem.no': {
          if (!this.joining.has(msg.id) || !['used', 'expired', 'revoked', 'denied'].includes(msg.reason)) return
          const j = this.store.joins[msg.id]
          this.cancelJoin(msg.id)
          this.store.dropJoin(msg.id)
          this.emit('join-failed', msg.id, msg.reason, j)
          return
        }
        case 'pong':
          if (typeof msg.ts === 'number') {
            peer.rtt = Math.max(0, Date.now() - msg.ts)
            if (peer.groups.size) this.emit('peer-update', this.peerInfo(peer))
          }
          return
      }

      if (!peer.groups.size) return // everything below requires membership

      switch (msg.t) {
        case 'sync': {
          if (!peer.groups.has(msg.g)) return
          const missing = this.store.opsMissingFrom(msg.g, msg.vec, { stubs: peer.proto >= 2 })
          const flush = (batch) => {
            const w = this.store.wire(msg.g, batch)
            this._send(peer, { t: 'ops', g: msg.g, ops: w.ops, proofs: w.proofs.length ? w.proofs : undefined })
          }
          let batch = []
          let bytes = 0
          for (const op of missing) {
            batch.push(op)
            bytes += 300 + JSON.stringify(op.d).length
            if (bytes > SYNC_BATCH_BYTES) {
              flush(batch)
              batch = []
              bytes = 0
            }
          }
          if (batch.length) flush(batch)
          return
        }
        case 'ops': {
          if (!peer.groups.has(msg.g)) return
          const { accepted, gap, membership } = this.store.ingest(msg.g, msg.ops, msg.proofs)
          if (membership) this.membershipChanged(msg.g)
          if (accepted.length) {
            this.emit('ops', msg.g, accepted)
            this.broadcastOps(msg.g, accepted, peer.key) // gossip to friends who may lack them
            if (accepted.some(op => op.k.startsWith('invite.') || op.k === 'group.settings' || op.k === 'member.role')) this.refreshInvites()
          }
          if (gap) {
            const last = peer.lastGapSync.get(msg.g) || 0
            if (Date.now() - last > 2000) {
              peer.lastGapSync.set(msg.g, Date.now())
              this._send(peer, { t: 'sync', g: msg.g, vec: this.store.vector(msg.g) })
            }
          }
          return
        }
        case 'eph':
          if (!peer.groups.has(msg.g) || !msg.d || typeof msg.d !== 'object') return
          this.emit('eph', msg.g, peer.key, msg.d)
          return
        case 'blob.get':
          this._serveBlob(peer, msg.id >>> 0, String(msg.h))
          return
        case 'blob.start': {
          const tr = this.incoming.get(peer.key + ':' + (msg.id >>> 0))
          if (tr) tr.start(Number(msg.size))
          return
        }
        case 'blob.end': {
          const tr = this.incoming.get(peer.key + ':' + (msg.id >>> 0))
          if (tr) tr.end()
          return
        }
        case 'blob.none': {
          const id = peer.key + ':' + (msg.id >>> 0)
          const tr = this.incoming.get(id)
          if (tr) { this.incoming.delete(id); tr.fail(new Error('Peer does not have this file')) }
        }
      }
    } catch (err) {
      this.emit('warning', err)
    }
  }

  // ---- blobs ----

  _serveBlob (peer, id, hash) {
    if (!this.store.hasBlob(hash)) { this._send(peer, { t: 'blob.none', id }); return }
    const file = this.store.blobPath(hash)
    const size = fs.statSync(file).size
    this._send(peer, { t: 'blob.start', id, size })
    const rs = fs.createReadStream(file, { highWaterMark: BLOB_CHUNK })
    peer.serving.add(rs)
    rs.on('data', (chunk) => {
      if (peer.conn.destroyed) { rs.destroy(); return }
      if (!peer.conn.write(encodeBlobChunk(id, chunk))) {
        rs.pause()
        peer.conn.once('drain', () => rs.resume())
      }
    })
    rs.on('end', () => { peer.serving.delete(rs); this._send(peer, { t: 'blob.end', id }) })
    rs.on('error', () => { peer.serving.delete(rs); this._send(peer, { t: 'blob.none', id }) })
  }

  _onBlobChunk (peer, id, data) {
    const tr = this.incoming.get(peer.key + ':' + id)
    if (tr) tr.chunk(data)
  }

  _requestBlob (peer, hash, onProgress) {
    return new Promise((resolve, reject) => {
      const id = this.nextTransferId++
      const mapKey = peer.key + ':' + id
      const final = this.store.blobPath(hash)
      const tmp = final + '.part' + id
      const ws = fs.createWriteStream(tmp)
      const hasher = crypto.createHash('sha256')
      let size = -1
      let received = 0
      let lastProgress = 0
      let timer = null
      let settled = false
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          if (this.incoming.delete(mapKey)) tr.fail(new Error('Transfer timed out'))
        }, BLOB_IDLE_TIMEOUT)
      }
      const tr = {
        peer,
        start: (s) => { size = s; arm() },
        chunk: (data) => {
          if (settled) return
          received += data.length
          if (size >= 0 && received > size) { tr.fail(new Error('Peer sent too much data')); return }
          hasher.update(data)
          ws.write(data)
          arm()
          const now = Date.now()
          if (onProgress && now - lastProgress > 150) { lastProgress = now; onProgress(received, size) }
        },
        end: () => {
          this.incoming.delete(mapKey)
          clearTimeout(timer)
          ws.end(() => {
            if (settled) return
            settled = true
            if (hasher.digest('hex') !== hash || (size >= 0 && received !== size)) {
              fs.rm(tmp, { force: true }, () => {})
              reject(new Error('File failed integrity check'))
              return
            }
            try { fs.renameSync(tmp, final) } catch (err) { if (!this.store.hasBlob(hash)) { reject(err); return } }
            if (onProgress) onProgress(received, size)
            resolve(final)
          })
        },
        fail: (err) => {
          this.incoming.delete(mapKey)
          clearTimeout(timer)
          if (settled) return
          settled = true
          ws.destroy()
          fs.rm(tmp, { force: true }, () => {})
          reject(err)
        }
      }
      this.incoming.set(mapKey, tr)
      arm()
      this._send(peer, { t: 'blob.get', id, h: hash })
    })
  }

  fetchBlob (hash, { groupId, onProgress } = {}) {
    if (this.store.hasBlob(hash)) return Promise.resolve(this.store.blobPath(hash))
    if (this.inflight.has(hash)) return this.inflight.get(hash)
    const p = (async () => {
      const candidates = [...this.peers.values()].filter(x => x.groups.size)
        .sort((a, b) => (b.groups.has(groupId) ? 1 : 0) - (a.groups.has(groupId) ? 1 : 0))
      let lastErr = new Error('Nobody who has this file is online right now')
      for (const peer of candidates) {
        try { return await this._requestBlob(peer, hash, onProgress) } catch (err) { lastErr = err }
      }
      throw lastErr
    })()
    this.inflight.set(hash, p)
    p.finally(() => this.inflight.delete(hash)).catch(() => {})
    return p
  }
}

// Copy a local file into the content-addressed blob store; returns { hash, size }.
async function importBlobFile (store, srcPath) {
  const hasher = crypto.createHash('sha256')
  const tmp = require('path').join(store.blobsDir, 'import-' + crypto.randomBytes(6).toString('hex'))
  let size = 0
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(srcPath)
    const ws = fs.createWriteStream(tmp)
    rs.on('data', (d) => { hasher.update(d); size += d.length })
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', resolve)
    rs.pipe(ws)
  })
  const hash = hasher.digest('hex')
  if (store.hasBlob(hash)) fs.rmSync(tmp, { force: true })
  else fs.renameSync(tmp, store.blobPath(hash))
  return { hash, size }
}

function importBlobBuffer (store, buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  if (!store.hasBlob(hash)) {
    const tmp = store.blobPath(hash) + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, store.blobPath(hash))
  }
  return { hash, size: buf.length }
}

module.exports = { Network, importBlobFile, importBlobBuffer, isLanAddress, defaultRoute, VPN_IFACE }
