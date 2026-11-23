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

test('kick: rotates the key, cuts the kicked friend off, old invites stop working, re-invite works', async (t) => {
  const alice = await makeNode('k-alice')
  const bob = await makeNode('k-bob')
  const carol = await makeNode('k-carol')
  const frank = await makeNode('k-frank')
  const nodes = [alice, bob, carol, frank]
  t.after(async () => { await Promise.all(nodes.map(n => n.net.stop())) })

  const group = alice.store.createGroup('Mods')
  const gid = group.id
  alice.net.joinGroup(group)
  const oldInvite = alice.store.inviteFor(gid)
  for (const n of [bob, carol, frank]) n.net.joinGroup(n.store.joinGroup(oldInvite).group)
  const g = (n) => n.store.groups.get(gid)
  await waitFor(() => alice.net.peersIn(gid).length === 3 && [bob, carol, frank].every(n => g(alice).byAuthor.has(n.store.myKey)), 20000, 'everyone connected')
  for (const n of nodes) assert.strictEqual(g(n).owner, alice.store.myKey, n.name + ' knows the owner')

  // Roles: only the owner appoints admins; admins can't kick the owner
  assert.throws(() => bob.store.setRole(gid, carol.store.myKey, 'admin'), /owner/)
  const role = alice.store.setRole(gid, bob.store.myKey, 'admin')
  alice.net.broadcastOps(gid, [role])
  await waitFor(() => g(bob).admins.has(bob.store.myKey) && g(carol).admins.has(bob.store.myKey), 10000, 'admin role to sync')
  assert.ok(!bob.store.canModerate(g(bob), bob.store.myKey, alice.store.myKey), 'admin cannot kick the owner')
  assert.ok(!carol.store.canModerate(g(carol), carol.store.myKey, bob.store.myKey), 'member cannot kick')

  // Frank goes offline; Bob (admin) kicks Carol
  await frank.net.stop()
  await waitFor(() => alice.net.peersIn(gid).length === 2, 10000, 'frank offline')
  const kick = bob.store.kick(gid, carol.store.myKey)
  bob.net.broadcastOps(gid, [kick]) // same order as the app: carol gets told, then cut off
  bob.net.membershipChanged(gid)
  assert.strictEqual(g(bob).epoch, 1)
  await waitFor(() => g(alice).epoch === 1, 10000, 'alice to get the new key')
  assert.ok(g(alice).secret.equals(g(bob).secret), 'alice and bob share the new key')
  await waitFor(() => g(carol).kickedMe, 10000, 'carol to learn she was removed')
  assert.ok(!g(carol).epochs.has(1), 'carol cannot open the new key')
  await waitFor(() => !alice.net.peersIn(gid).some(p => p.key === carol.store.myKey) && !bob.net.peersIn(gid).some(p => p.key === carol.store.myKey), 10000, 'carol cut off')

  const after = alice.store.append(gid, 'msg', { id: 'secret-plans', ch: 'x', text: 'after the kick' })
  alice.net.broadcastOps(gid, [after])
  await waitFor(() => texts(bob, gid).includes('after the kick'), 5000, 'bob gets new messages')
  await new Promise(r => setTimeout(r, 2500))
  assert.ok(!texts(carol, gid).includes('after the kick'), 'carol must not get messages after the kick')

  // Someone with the OLD invite and a fresh identity is refused (only existing members may use old keys)
  const dave = await makeNode('k-dave')
  nodes.push(dave)
  dave.net.joinGroup(dave.store.joinGroup(oldInvite).group)
  await new Promise(r => setTimeout(r, 4000))
  assert.ok(!alice.net.peersIn(gid).some(p => p.key === dave.store.myKey), 'old invite must not admit newcomers')
  assert.strictEqual(texts(dave, gid).length, 0)

  // Frank was offline during the kick: comes back on the old key, gets the new one from a friend
  frank.net = new Network(frank.store, { bootstrap: testnet.bootstrap, authTimeout: 1500 })
  await frank.net.start()
  await waitFor(() => g(frank).epoch === 1 && texts(frank, gid).includes('after the kick'), 20000, 'frank to catch up on the new key')
  assert.ok(g(frank).secret.equals(g(alice).secret))

  // A brand-new friend with the NEW invite gets in; so does Carol when re-invited
  const newInvite = alice.store.inviteFor(gid)
  assert.notStrictEqual(newInvite, oldInvite)
  const eve = await makeNode('k-eve')
  nodes.push(eve)
  eve.net.joinGroup(eve.store.joinGroup(newInvite).group)
  await waitFor(() => texts(eve, gid).includes('after the kick'), 15000, 'eve joins with the new invite')

  assert.strictEqual(g(carol).kickedMe || !g(carol).epochs.has(1), true)
  const re = carol.store.joinGroup(newInvite)
  assert.strictEqual(re.existed, true)
  assert.strictEqual(re.rekeyed, true)
  carol.net.joinGroup(re.group)
  await waitFor(() => texts(carol, gid).includes('after the kick'), 15000, 'carol back after re-invite')
  assert.strictEqual(g(carol).kickedMe, false)
})

test('friends: request by friend code, accept, private chat only the two can join', async (t) => {
  const alice = await makeNode('f-alice')
  const bob = await makeNode('f-bob')
  const carol = await makeNode('f-carol')
  t.after(async () => { await Promise.all([alice, bob, carol].map(n => n.net.stop())) })
  const requests = []
  bob.net.on('friend-request', (key) => requests.push(key))

  // Alice adds Bob with his friend code; they share no group, so the request is dialled directly
  const { group: aliceDm, key } = alice.store.addFriend(bob.store.friendCode())
  assert.strictEqual(key, bob.store.myKey)
  alice.net.joinGroup(aliceDm)
  alice.net.sendFriendRequest(key)
  await waitFor(() => requests.includes(alice.store.myKey), 20000, 'bob to receive the friend request')
  assert.strictEqual(bob.store.friendsInfo().incoming[0].name, 'f-alice')
  await waitFor(() => !alice.net.friendQueue.has(key), 5000, 'delivery confirmed')
  assert.ok(!alice.store.isFriend(bob.store.myKey), 'not friends until bob accepts')

  // Bob accepts: both derive the same private chat and connect
  const bobDm = bob.store.acceptFriend(alice.store.myKey)
  assert.strictEqual(bobDm.id, aliceDm.id, 'both sides derive the same private chat')
  bob.net.joinGroup(bobDm)
  await waitFor(() => alice.store.isFriend(bob.store.myKey), 15000, 'alice sees bob accepted')
  assert.strictEqual(alice.store.friendsInfo().outgoing.length, 0)
  const m = alice.store.append(aliceDm.id, 'msg', { id: 'dm1', ch: 'dm', text: 'just us' })
  alice.net.broadcastOps(aliceDm.id, [m])
  await waitFor(() => texts(bob, aliceDm.id).includes('just us'), 5000, 'private message')

  // Even someone holding the private chat's secret can't get in: it's exactly two people
  const stolen = { ...aliceDm }
  const intruder = carol.store._createGroup({ id: stolen.id, secret: stolen.secret, dm: alice.store.myKey })
  carol.net.joinGroup(intruder)
  await new Promise(r => setTimeout(r, 4000))
  assert.ok(!alice.net.peersIn(aliceDm.id).some(p => p.key === carol.store.myKey), 'third party refused')
  assert.strictEqual(texts(carol, aliceDm.id).length, 0)
  assert.throws(() => alice.store.inviteFor(aliceDm.id), /Private chats/)
})
