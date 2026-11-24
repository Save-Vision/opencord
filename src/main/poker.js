'use strict'
// Mental poker: dealing cards between friends with no dealer that could peek.
//
// Cards are points on the ed25519 curve (its prime-order subgroup). "Encrypting" a point P with
// a secret number k means computing k·P, and these locks commute: a·(b·P) = b·(a·P). So:
//
//  1. Shuffle: each player in turn locks every card with their own key k and shuffles the deck.
//     After everyone, nobody knows which card is where.
//  2. Lock: each player in turn removes their k again and locks card j with its own key kⱼ.
//     Now card j = k₁ⱼ·k₂ⱼ·…·M, and the deck order no longer changes.
//  3. To show card j to Bob, everyone else publishes their kⱼ; only Bob adds his own and sees
//     the card. To show a card to everyone (the flop), everyone publishes. A folded hand is
//     never shown, because its owner never publishes their key for it.
//
// Card points come from hashing (Elligator 2, crypto_core_ed25519_from_uniform), so nobody
// knows how two cards relate. That way a wrong key opens to a point that isn't a card, and each
// player's commitments (kⱼ·B, published in step 2) show whose key was wrong.
//
// The keys are derived from your identity and the table, so a restarted app can carry on.
// They never leave this process except as the reveals the game requires.

const crypto = require('crypto')
const sodium = require('sodium-native')

const PT = sodium.crypto_core_ed25519_BYTES // 32
const SC = sodium.crypto_core_ed25519_SCALARBYTES // 32
const DECK = 52
const isHex32 = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)

// The 52 cards, in a fixed order: index = rank * 4 + suit (rank 0 = 2 … 12 = ace)
const CARDS = []
for (let i = 0; i < DECK; i++) {
  const r = crypto.createHash('sha256').update('opendiscord/poker/card/v1/' + i).digest()
  const p = Buffer.alloc(PT)
  sodium.crypto_core_ed25519_from_uniform(p, r)
  CARDS.push(p)
}
const CARD_INDEX = new Map(CARDS.map((p, i) => [p.toString('hex'), i]))

function scalarFrom (bytes64) {
  const s = Buffer.alloc(SC)
  sodium.crypto_core_ed25519_scalar_reduce(s, bytes64)
  return s
}

function mul (k, P) {
  const out = Buffer.alloc(PT)
  sodium.crypto_scalarmult_ed25519_noclamp(out, k, P)
  return out
}

function invert (k) {
  const out = Buffer.alloc(SC)
  sodium.crypto_core_ed25519_scalar_invert(out, k)
  return out
}

function point (hex) {
  if (!isHex32(hex)) throw new Error('Not a card')
  const p = Buffer.from(hex, 'hex')
  if (!sodium.crypto_core_ed25519_is_valid_point(p)) throw new Error('Not a card')
  return p
}

function checkDeck (deck) {
  if (!Array.isArray(deck) || deck.length !== DECK || new Set(deck).size !== DECK) throw new Error('Not a full deck')
  return deck.map(point)
}

// Your keys for one hand at one table
function handKeys (seed, table, hand) {
  const derive = (label) => scalarFrom(crypto.createHmac('sha512', seed).update(`opendiscord/poker/v1/${table}/${hand}/${label}`).digest())
  return { k: derive('shuffle'), card: (j) => derive('card/' + j) }
}

// Step 1: lock every card with k and shuffle. Player 1 starts from the plain deck.
function shuffle (seed, table, hand, deck) {
  const pts = deck == null ? CARDS : checkDeck(deck)
  const { k } = handKeys(seed, table, hand)
  const out = pts.map(p => mul(k, p).toString('hex'))
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// Step 2: swap the shuffle lock for one key per card; also the commitments kⱼ·B
function lock (seed, table, hand, deck) {
  const pts = checkDeck(deck)
  const { k, card } = handKeys(seed, table, hand)
  const kInv = invert(k)
  const out = []
  const commits = []
  pts.forEach((p, j) => {
    const kj = card(j)
    out.push(mul(kj, mul(kInv, p)).toString('hex'))
    const c = Buffer.alloc(PT)
    sodium.crypto_scalarmult_ed25519_base_noclamp(c, kj)
    commits.push(c.toString('hex'))
  })
  return { deck: out, commits }
}

// Step 3: my keys for these deck positions
function reveal (seed, table, hand, indices) {
  const { card } = handKeys(seed, table, hand)
  const out = {}
  for (const j of indices) if (Number.isInteger(j) && j >= 0 && j < DECK) out[j] = card(j).toString('hex')
  return out
}

// Does a revealed key match its commitment?
function keyMatches (keyHex, commitHex) {
  if (!isHex32(keyHex) || !isHex32(commitHex)) return false
  const c = Buffer.alloc(PT)
  try { sodium.crypto_scalarmult_ed25519_base_noclamp(c, Buffer.from(keyHex, 'hex')) } catch { return false }
  return c.toString('hex') === commitHex
}

// Remove every key from a locked card: the card's index, or -1 if the keys don't open it
function open (lockedHex, keysHex) {
  let p = point(lockedHex)
  for (const h of keysHex) {
    if (!isHex32(h)) return -1
    try { p = mul(invert(Buffer.from(h, 'hex')), p) } catch { return -1 }
  }
  const i = CARD_INDEX.get(p.toString('hex'))
  return i == null ? -1 : i
}

// Open with my own key for that position added (my hole cards)
function openMine (seed, table, hand, j, lockedHex, othersHex) {
  const mine = handKeys(seed, table, hand).card(j).toString('hex')
  return open(lockedHex, [...othersHex, mine])
}

module.exports = { DECK, shuffle, lock, reveal, open, openMine, keyMatches, handKeys }
