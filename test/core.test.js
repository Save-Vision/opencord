'use strict'
// Headless tests for storage, sync, auth and file transfer, on a private local DHT.
// Run: npm test
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const { Store } = require('../src/main/store')
const { Network, importBlobBuffer } = require('../src/main/network')
const c = require('../src/main/crypto')
const { encodeJSON, FrameParser } = require('../src/main/framing')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-test-'))
let testnet

async function makeNode (name) {
  const store = new Store(path.join(tmpRoot, name)).load()
  store.setProfile({ name })
  const net = new Network(store, { bootstrap: testnet.bootstrap, authTimeout: 1500 })
  const node = { name, store, net, ops: [] }
  net.on('ops', (g, ops) => node.ops.push(...ops))
  await net.start()
  return node
}

function waitFor (fn, ms = 15000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      let v
      try { v = fn() } catch {}
      if (v) { clearInterval(iv); resolve(v) } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('Timed out waiting for ' + label)) }
    }, 50)
  })
}

const texts = (node, gid) => node.store.groups.get(gid).ops.filter(o => o.k === 'msg').map(o => o.d.text).sort()

test.before(async () => { testnet = await createTestnet(4) })
test.after(async () => {
  await testnet.destroy()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('framing round-trips JSON and binary across arbitrary chunk boundaries', () => {
  const frames = []
  const p = new FrameParser(f => frames.push(f))
  const { encodeBlobChunk } = require('../src/main/framing')
  const bin = crypto.randomBytes(100000)
  const all = Buffer.concat([encodeJSON({ t: 'x', n: 1 }), encodeBlobChunk(7, bin), encodeJSON({ t: 'y' })])
  for (let i = 0; i < all.length; i += 777) p.push(all.subarray(i, i + 777))
  assert.strictEqual(frames.length, 3)
  assert.deepStrictEqual(frames[0].msg, { t: 'x', n: 1 })
  assert.strictEqual(frames[1].id, 7)
  assert.ok(frames[1].data.equals(bin))
  assert.strictEqual(frames[2].msg.t, 'y')
})

test('invite codes round-trip and reject garbage', () => {
  const secret = crypto.randomBytes(32)
  const parsed = c.parseInvite(c.makeInvite(secret, 'The Boys'))
  assert.ok(parsed.secret.equals(secret))
  assert.strictEqual(parsed.name, 'The Boys')
  assert.throws(() => c.parseInvite('hello'))
  assert.throws(() => c.parseInvite('OD1-bm9wZQ'))
})

test('next release version counts up from published releases', () => {
  const { nextVersion } = require('../scripts/next-version')
  assert.strictEqual(nextVersion('0.2.0', []), '0.2.0')
  assert.strictEqual(nextVersion('0.2.0', ['v0.2.0', 'v0.2.1']), '0.2.2')
  assert.strictEqual(nextVersion('0.2.0', ['v0.2.9', 'v0.2.10', 'junk', '']), '0.2.11')
  assert.strictEqual(nextVersion('0.3.0', ['v0.2.7']), '0.3.0')
  assert.strictEqual(nextVersion('0.2.0', ['v0.3.4']), '0.3.5')
})

test('profile pictures are validated, fit in an op, and can be removed', () => {
  const { MAX_AVATAR_CHARS } = require('../src/main/store')
  const store = new Store(path.join(tmpRoot, 'pic')).load()
  const prefix = 'data:image/webp;base64,'
  const biggest = prefix + 'A'.repeat(MAX_AVATAR_CHARS - prefix.length)
  assert.strictEqual(store.setProfile({ name: 'Pic', avatar: biggest }).avatar, biggest)
  const g = store.createGroup('Pics')
  const op = store.append(g.id, 'profile', store.profileData()) // must not exceed the op size limit
  assert.strictEqual(op.d.avatar, biggest)
  assert.throws(() => store.setProfile({ avatar: biggest + 'AAAA' }), /small/)
  assert.throws(() => store.setProfile({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPEG or WebP/)
  assert.throws(() => store.setProfile({ avatar: 'https://example.com/me.png' }))
  store.setProfile({ avatar: null })
  assert.strictEqual(store.profileData().avatar, undefined)
  assert.strictEqual(store.publicIdentity().avatar, null)
})

test('three friends: join, live chat, offline catch-up via a third peer, files, intruders', async (t) => {
  const alice = await makeNode('alice')
  const bob = await makeNode('bob')
  t.after(async () => { await Promise.all([alice.net.stop(), bob.net.stop()]) })

  // Alice creates a group, Bob joins with the invite
  const group = alice.store.createGroup('Squad')
  alice.net.joinGroup(group)
  const invite = alice.store.inviteFor(group.id)
  const { group: bobGroup } = bob.store.joinGroup(invite)
  bob.net.joinGroup(bobGroup)
  assert.strictEqual(bobGroup.id, group.id)

  await waitFor(() => bob.store.groups.get(group.id).ops.length >= 5, 20000, 'bob to sync alice history')
  await waitFor(() => alice.store.groups.get(group.id).byAuthor.has(bob.store.myKey), 10000, 'alice to get bob profile')
  assert.strictEqual(bob.store.groupName(bob.store.groups.get(group.id)), 'Squad')

  // Live message
  const op = alice.store.append(group.id, 'msg', { id: 'm1', ch: 'x', text: 'hello bob' })
  alice.net.broadcastOps(group.id, [op])
  await waitFor(() => texts(bob, group.id).includes('hello bob'), 5000, 'live message')

  // Ephemeral messages (typing / voice signalling) reach only group peers
  const ephs = []
  bob.net.on('eph', (g, from, d) => ephs.push({ g, from, d }))
  alice.net.sendEphemeral(group.id, null, { type: 'typing', ch: 'x' })
  await waitFor(() => ephs.length === 1, 5000, 'ephemeral')
  assert.strictEqual(ephs[0].from, alice.store.myKey)

  // RTT measured by pings
  await waitFor(() => alice.net.onlinePeers()[0]?.rtt != null, 12000, 'rtt')

  // Diagnostics: the group shows one connected friend, and failed dials are recorded with a reason
  const diag = await alice.net.diagnostics()
  assert.strictEqual(diag.dht.online, true)
  assert.deepStrictEqual({ found: diag.groups[group.id].found, connected: diag.groups[group.id].connected }, { found: 1, connected: 1 })
  const ghost = crypto.randomBytes(32)
  alice.net.swarm.dht.connect(ghost).on('error', () => {})
  await waitFor(() => alice.net.failures.get(ghost.toString('hex')), 15000, 'failed dial to be recorded')
  assert.ok(alice.net.failures.get(ghost.toString('hex')).code)

  // File transfer with integrity check
  const data = crypto.randomBytes(3 * 1024 * 1024 + 123)
  const { hash } = importBlobBuffer(alice.store, data)
  let progressed = false
  const file = await bob.net.fetchBlob(hash, { groupId: group.id, onProgress: () => { progressed = true } })
  assert.ok(fs.readFileSync(file).equals(data))
  assert.ok(progressed)
  await assert.rejects(bob.net.fetchBlob('0'.repeat(64), { groupId: group.id }))

  // Carol joins while Alice is OFFLINE: she must still get Alice's messages through Bob
  await alice.net.stop()
  await waitFor(() => bob.net.onlinePeers().length === 0, 15000, 'bob to notice alice left')
  const carol = await makeNode('carol')
  t.after(() => carol.net.stop())
  const { group: carolGroup } = carol.store.joinGroup(invite)
  carol.net.joinGroup(carolGroup)
  await waitFor(() => texts(carol, group.id).includes('hello bob'), 20000, 'carol to get alice history via bob')
  assert.strictEqual(carol.store.groupName(carol.store.groups.get(group.id)), 'Squad')

  // Carol's messages flow back to bob, and a forged op claiming to be from Alice is rejected
  const cop = carol.store.append(group.id, 'msg', { id: 'm2', ch: 'x', text: 'hi from carol' })
  carol.net.broadcastOps(group.id, [cop])
  await waitFor(() => texts(bob, group.id).includes('hi from carol'), 5000, 'carol -> bob')

  const aliceOps = bob.store.groups.get(group.id).byAuthor.get(alice.store.myKey)
  const forged = { ...aliceOps[aliceOps.length - 1], s: aliceOps.length + 1, d: { id: 'evil', ch: 'x', text: 'forged' } }
  const res = bob.store.ingest(group.id, [forged])
  assert.strictEqual(res.accepted.length, 0, 'forged op must be rejected')

  // Intruder: knows the public DHT topic but NOT the secret. Must get nothing and be kicked.
  const mallory = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.after(() => mallory.destroy())
  let gotData = false
  let closed = false
  mallory.on('connection', (conn) => {
    conn.on('error', () => {})
    conn.write(encodeJSON({ t: 'hello', v: 1, tags: [crypto.randomBytes(32).toString('hex')] }))
    conn.write(encodeJSON({ t: 'sync', g: group.id, vec: {} }))
    const parser = new FrameParser((f) => { if (f.kind === 'json' && f.msg.t === 'ops') gotData = true })
    conn.on('data', d => parser.push(d))
    conn.on('close', () => { closed = true })
  })
  mallory.join(group.topic, { server: false, client: true })
  await waitFor(() => closed, 20000, 'intruder to be disconnected')
  assert.strictEqual(gotData, false, 'intruder must not receive any group data')
})
