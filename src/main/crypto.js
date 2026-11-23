'use strict'
// Cryptographic helpers. Transport encryption is handled by Hyperswarm (Noise XX +
// libsodium secretstream) and WebRTC (DTLS-SRTP); this module adds group membership
// proofs, op signatures and invite codes on top.
const crypto = require('crypto')
const hc = require('hypercore-crypto')

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

function makeInvite (secret, name) {
  const body = Buffer.from(JSON.stringify({ s: secret.toString('base64url'), n: name || '' }))
  return INVITE_PREFIX + body.toString('base64url')
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
  return { secret, name: String(body.n || '').slice(0, 100) }
}

module.exports = {
  sha256, groupIdFromSecret, topicFromSecret, authTag, safeEqualHex,
  canonical, signOp, verifyOp, makeInvite, parseInvite,
  randomBytes: (n) => crypto.randomBytes(n),
  keyPair: (seed) => hc.keyPair(seed)
}
