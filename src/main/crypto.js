'use strict'
// Cryptographic helpers. Transport encryption is handled by Hyperswarm (Noise XX +
// libsodium secretstream) and WebRTC (DTLS-SRTP); this module adds group membership
// proofs, op signatures and invite codes on top.
const crypto = require('crypto')
const hc = require('hypercore-crypto')
const sodium = require('sodium-native')

const INVITE_PREFIX = 'OD1-'

function sha256 (...parts) {
  const h = crypto.createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

const groupIdFromSecret = (secret) => sha256('opendiscord/group-id/v1', secret).subarray(0, 16).toString('hex')
// The topic is what gets announced on the public DHT. It is derived one-way from the
// secret, so DHT nodes learn nothing that lets them join.
const topicFromSecret = (secret) => sha256('opendiscord/topic/v1', secret)

// Membership proof bound to one specific Noise session (handshakeHash) and the sender's
// static key, so a tag cannot be replayed on another connection or by another peer.
function authTag (secret, handshakeHash, senderPublicKey) {
  return crypto.createHmac('sha256', secret)
    .update('opendiscord/auth/v1')
    .update(handshakeHash)
    .update(senderPublicKey)
    .digest('hex')
}

function safeEqualHex (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// Deterministic JSON (sorted keys) so signatures verify regardless of key order.
function canonical (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

const opSigningBytes = (op) => Buffer.from('opendiscord/op/v1' + canonical([op.g, op.a, op.s, op.t, op.k, op.d]))

function signOp (op, secretKey) {
  return hc.sign(opSigningBytes(op), secretKey).toString('hex')
}

function verifyOp (op) {
  try {
    if (typeof op.sig !== 'string' || op.sig.length !== 128) return false
    if (typeof op.a !== 'string' || op.a.length !== 64) return false
    return hc.verify(opSigningBytes(op), Buffer.from(op.sig, 'hex'), Buffer.from(op.a, 'hex'))
  } catch { return false }
}

// An invite carries the group's current secret, plus (since 0.3) the stable group id, the
// key epoch and the owner's public key. The owner key is the root of trust for moderation.
function makeInvite (secret, name, extra = {}) {
  const body = { s: secret.toString('base64url'), n: name || '' }
  if (extra.id) body.i = extra.id
  if (extra.epoch) body.e = extra.epoch
  if (extra.owner) body.o = extra.owner
  return INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url')
}

function parseInvite (code) {
  code = String(code || '').trim()
  if (!code.startsWith(INVITE_PREFIX)) throw new Error('Not an OpenDiscord invite code')
  let body
  try { body = JSON.parse(Buffer.from(code.slice(INVITE_PREFIX.length), 'base64url').toString()) } catch {
    throw new Error('Invite code is damaged — copy it again')
  }
  const secret = Buffer.from(body.s || '', 'base64url')
  if (secret.length !== 32) throw new Error('Invite code is damaged — copy it again')
  const id = /^[0-9a-f]{32}$/.test(body.i || '') ? body.i : groupIdFromSecret(secret)
  const epoch = Number.isInteger(body.e) && body.e >= 0 ? body.e : 0
  const owner = /^[0-9a-f]{64}$/.test(body.o || '') ? body.o : null
  return { secret, name: String(body.n || '').slice(0, 100), id, epoch, owner }
}

// Sealed boxes to a member's identity key (Ed25519 converted to X25519). Used to hand the
// new group secret to each remaining member after a kick, inside a signed op.
function sealTo (publicKeyHex, data) {
  const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(pk, Buffer.from(publicKeyHex, 'hex'))
  const out = Buffer.alloc(data.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, data, pk)
  return out.toString('base64')
}

// Our X25519 secret key. A plain Buffer, wiped after use: sodium_malloc's guarded memory is an
// external ArrayBuffer, which Electron's V8 memory cage refuses (it works in Node, fails in the app).
function curveSecret (keyPair) {
  const sk = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_sk_to_curve25519(sk, keyPair.secretKey)
  return sk
}

function openSealed (keyPair, b64) {
  let sk = null
  try {
    const ct = Buffer.from(String(b64), 'base64')
    if (ct.length <= sodium.crypto_box_SEALBYTES) return null
    const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
    sodium.crypto_sign_ed25519_pk_to_curve25519(pk, keyPair.publicKey)
    sk = curveSecret(keyPair)
    const out = Buffer.alloc(ct.length - sodium.crypto_box_SEALBYTES)
    return sodium.crypto_box_seal_open(out, ct, pk, sk) ? out : null
  } catch { return null } finally { if (sk) sodium.sodium_memzero(sk) }
}

// Private chats: both friends derive the same secret from an X25519 key exchange between
// their identity keys, so nobody else can ever compute it (or join the chat).
function dmSecret (keyPair, otherHex) {
  const mySk = curveSecret(keyPair)
  const theirPk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(theirPk, Buffer.from(otherHex, 'hex'))
  const shared = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult(shared, mySk, theirPk)
  sodium.sodium_memzero(mySk)
  const [a, b] = [keyPair.publicKey.toString('hex'), otherHex].sort()
  const secret = sha256('opendiscord/dm/v1', shared, a, b)
  sodium.sodium_memzero(shared)
  return secret
}

const FRIEND_PREFIX = 'ODF1-'
function makeFriendCode (publicKeyHex, name) {
  return FRIEND_PREFIX + Buffer.from(JSON.stringify({ k: publicKeyHex, n: name || '' })).toString('base64url')
}
function parseFriendCode (code) {
  code = String(code || '').trim()
  if (/^[0-9a-f]{64}$/i.test(code)) return { key: code.toLowerCase(), name: '' }
  if (code.startsWith(INVITE_PREFIX) || /^opendiscord:\/\/join\//i.test(code)) throw new Error("That's a group invite. Use “Join a group” for it.")
  if (/^opendiscord:\/\/friend\//i.test(code)) {
    const link = parseLink(code)
    return { key: link.key, name: link.name, token: link.token }
  }
  if (!code.startsWith(FRIEND_PREFIX)) throw new Error('Not an OpenDiscord friend link')
  let body
  try { body = JSON.parse(Buffer.from(code.slice(FRIEND_PREFIX.length), 'base64url').toString()) } catch { throw new Error('Friend code is damaged — copy it again') }
  if (!/^[0-9a-f]{64}$/.test(body.k || '')) throw new Error('Friend code is damaged — copy it again')
  return { key: body.k, name: String(body.n || '').slice(0, 32) }
}

// ---- one-time links (0.4) ----
//
// opendiscord://join/<…>   a group invite that works once
// opendiscord://friend/<…> a friend link that works once
//
// Unlike the old OD1 codes, a link holds no group secret, just a random token. Members keep
// three values derived from it in the group log (invite.create): an id, a DHT topic to wait on,
// and an HMAC key. Whoever opens the link proves they know the token, bound to the Noise
// session; a member who is online checks the invite is unused, records invite.used and hands
// over the group key in a sealed box. A leaked, used link is worthless.

const LINK_SCHEME = 'opendiscord://'

function linkKeys (token) {
  return {
    id: sha256('opendiscord/invite-id/v1', token).subarray(0, 16).toString('hex'),
    topic: sha256('opendiscord/invite-topic/v1', token),
    key: sha256('opendiscord/invite-key/v1', token)
  }
}

// Proof that the sender of this connection knows the token (via its derived key)
function redeemProof (key, handshakeHash, senderPublicKey) {
  return crypto.createHmac('sha256', key)
    .update('opendiscord/redeem/v1')
    .update(handshakeHash)
    .update(senderPublicKey)
    .digest('hex')
}

const LINK_VERSION = 1
// join: version | token 32 | group id 16 | inviter key 32 | expiry (u32 seconds, 0 = never) | group name
function makeJoinLink ({ token, gid, inviter, exp, name }) {
  const head = Buffer.alloc(85)
  head[0] = LINK_VERSION
  token.copy(head, 1)
  Buffer.from(gid, 'hex').copy(head, 33)
  Buffer.from(inviter, 'hex').copy(head, 49)
  head.writeUInt32BE(exp ? Math.floor(exp / 1000) : 0, 81)
  return LINK_SCHEME + 'join/' + Buffer.concat([head, Buffer.from(String(name || '').slice(0, 64))]).toString('base64url')
}

// friend: version | key 32 | token 32 | name
function makeFriendLink ({ key, token, name }) {
  const head = Buffer.alloc(65)
  head[0] = LINK_VERSION
  Buffer.from(key, 'hex').copy(head, 1)
  token.copy(head, 33)
  return LINK_SCHEME + 'friend/' + Buffer.concat([head, Buffer.from(String(name || '').slice(0, 32))]).toString('base64url')
}

// Returns null if the text is not an opendiscord:// link at all
function parseLink (text) {
  const m = /^opendiscord:\/\/(join|friend)\/([A-Za-z0-9_-]+)\/?$/i.exec(String(text || '').trim())
  if (!m) return null
  const kind = m[1].toLowerCase()
  const buf = Buffer.from(m[2], 'base64url')
  if (kind === 'join') {
    if (buf.length < 85 || buf[0] !== LINK_VERSION) throw new Error('This invite link is damaged — copy it again')
    const exp = buf.readUInt32BE(81) * 1000
    return {
      kind,
      token: Buffer.from(buf.subarray(1, 33)),
      gid: buf.subarray(33, 49).toString('hex'),
      inviter: buf.subarray(49, 81).toString('hex'),
      exp: exp || null,
      name: buf.subarray(85).toString('utf8').slice(0, 64)
    }
  }
  if (buf.length < 65 || buf[0] !== LINK_VERSION) throw new Error('This friend link is damaged — copy it again')
  return {
    kind,
    key: buf.subarray(1, 33).toString('hex'),
    token: Buffer.from(buf.subarray(33, 65)),
    name: buf.subarray(65).toString('utf8').slice(0, 32)
  }
}

module.exports = {
  sha256, groupIdFromSecret, topicFromSecret, authTag, safeEqualHex,
  canonical, signOp, verifyOp, makeInvite, parseInvite, sealTo, openSealed,
  dmSecret, makeFriendCode, parseFriendCode,
  linkKeys, redeemProof, makeJoinLink, makeFriendLink, parseLink,
  randomBytes: (n) => crypto.randomBytes(n),
  keyPair: (seed) => hc.keyPair(seed)
}
