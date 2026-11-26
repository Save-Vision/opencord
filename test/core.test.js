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

const onceEvent = (emitter, name, filter = () => true, ms = 25000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { emitter.off(name, fn); reject(new Error('Timed out waiting for ' + name)) }, ms)
  function fn (...args) { if (!filter(...args)) return; clearTimeout(t); emitter.off(name, fn); resolve(args) }
  emitter.on(name, fn)
})

// Both sides now have every op the other one wrote
const synced = (a, b, gid) => {
  const va = a.store.groups.get(gid)?.byAuthor
  const vb = b.store.groups.get(gid)?.byAuthor
  if (!va || !vb) return false
  for (const [k, list] of va) if ((vb.get(k)?.length || 0) < list.length) return false
  for (const [k, list] of vb) if ((va.get(k)?.length || 0) < list.length) return false
  return true
}

test('one-time invite links: a member lets the guest in, then the link refuses anyone else', async (t) => {
  const alice = await makeNode('i-alice')
  const bob = await makeNode('i-bob')
  const carol = await makeNode('i-carol')
  t.after(async () => { await Promise.all([alice, bob, carol].map(n => n.net.stop())) })

  const group = alice.store.createGroup('Link Squad')
  alice.net.joinGroup(group)
  const { link } = alice.store.createInvite(group.id, 3600e3)
  alice.net.refreshInvites()
  assert.match(link, /^opendiscord:\/\/join\/[A-Za-z0-9_-]+$/)
  assert.ok(!link.includes(group.secret.toString('base64url')), 'the link does not contain the group key')

  // Bob opens the link: alice checks it and hands over the key
  const { join } = bob.store.startJoin(link)
  assert.strictEqual(join.name, 'Link Squad')
  const joined = onceEvent(bob.net, 'joined', (id) => id === join.id)
  bob.net.startJoin(join)
  const [, res] = await joined
  assert.strictEqual(res.group.id, group.id)
  assert.ok(res.group.secret.equals(group.secret))
  await waitFor(() => synced(alice, bob, group.id), 20000, 'bob to sync')
  assert.strictEqual(bob.store.groupName(bob.store.groups.get(group.id)), 'Link Squad')
  assert.deepStrictEqual(Object.keys(bob.store.joins), [], 'pending join cleared')
  const inv = [...alice.store.invitesOf(alice.store.groups.get(group.id)).values()][0]
  assert.strictEqual(inv.used.key, bob.store.myKey)
  assert.strictEqual(alice.store.activeInvites(alice.store.groups.get(group.id)).length, 0)

  // Carol got the same (now used) link forwarded: refused, and she learns nothing
  const { join: cj } = carol.store.startJoin(link)
  const failed = onceEvent(carol.net, 'join-failed', (id) => id === cj.id)
  carol.net.startJoin(cj)
  const [, reason] = await failed
  assert.strictEqual(reason, 'used')
  assert.ok(!carol.store.groups.has(group.id))
  assert.deepStrictEqual(Object.keys(carol.store.joins), [])

  // A link bob made stops working once the owner limits invites to admins
  const { link: bobLink, op: bobInv } = bob.store.createInvite(group.id)
  bob.net.broadcastOps(group.id, [bobInv])
  bob.net.refreshInvites()
  await waitFor(() => alice.store.activeInvites(alice.store.groups.get(group.id)).length === 1, 10000, 'alice to see the invite bob made')
  const s = alice.store.append(group.id, 'group.settings', { invites: 'admins' })
  alice.net.broadcastOps(group.id, [s])
  await waitFor(() => bob.store.groupSettings(bob.store.groups.get(group.id)).invites === 'admins', 10000, 'setting to sync')
  assert.throws(() => bob.store.createInvite(group.id), /owner and admins/)
  assert.strictEqual(bob.store.activeInvites(bob.store.groups.get(group.id)).length, 0)
  const { join: cj2 } = carol.store.startJoin(bobLink)
  const failed2 = onceEvent(carol.net, 'join-failed', (id) => id === cj2.id)
  carol.net.startJoin(cj2)
  assert.strictEqual((await failed2)[1], 'revoked')

  // The owner can still invite, and a revoked link is refused
  const { link: l3, op: o3 } = alice.store.createInvite(group.id)
  const rv = alice.store.append(group.id, 'invite.revoke', { id: o3.d.id })
  alice.net.broadcastOps(group.id, [o3, rv])
  alice.net.refreshInvites()
  assert.throws(() => carol.store.startJoin('opendiscord://join/AAAA'), /invite link/)
  const { join: cj3 } = carol.store.startJoin(l3)
  const failed3 = onceEvent(carol.net, 'join-failed', (id) => id === cj3.id)
  carol.net.startJoin(cj3)
  assert.strictEqual((await failed3)[1], 'revoked')
})

test('friend links: opening one makes you friends right away, and it works only once', async (t) => {
  const alice = await makeNode('fl-alice')
  const bob = await makeNode('fl-bob')
  const carol = await makeNode('fl-carol')
  t.after(async () => { await Promise.all([alice, bob, carol].map(n => n.net.stop())) })

  const link = alice.store.createFriendLink(3600e3)
  assert.match(link, /^opendiscord:\/\/friend\//)
  assert.strictEqual(alice.store.friendsInfo().links.length, 1)

  const linked = onceEvent(alice.net, 'friend-linked', (key) => key === bob.store.myKey)
  const { group: bobDm, key } = bob.store.addFriend(link)
  assert.strictEqual(key, alice.store.myKey)
  bob.net.joinGroup(bobDm)
  bob.net.sendFriendRequest(key)
  const [, aliceDm] = await linked
  assert.strictEqual(aliceDm.id, bobDm.id)
  assert.strictEqual(alice.store.friendsInfo().incoming.length, 0, 'no request to click through')
  await waitFor(() => alice.store.isFriend(bob.store.myKey), 15000, 'alice to get bob in the private chat')
  await waitFor(() => bob.store.isFriend(alice.store.myKey), 15000, 'bob to see they are friends')
  const m = bob.store.append(bobDm.id, 'msg', { id: 'hi', ch: 'dm', text: 'got your link' })
  bob.net.broadcastOps(bobDm.id, [m])
  await waitFor(() => texts(alice, aliceDm.id).includes('got your link'), 5000, 'message over the new chat')
  assert.strictEqual(alice.store.friendsInfo().links.length, 0, 'used links are no longer listed')
  assert.ok(!JSON.stringify(bob.store.friendsInfo()).includes(c.parseLink(link).token.toString('hex')), 'token not exposed to the UI')

  // Carol has the same link: alice says no, and carol's side drops the pending friend
  const rejected = onceEvent(carol.net, 'friend-rejected', (k) => k === alice.store.myKey)
  const { group: carolDm } = carol.store.addFriend(link)
  carol.net.joinGroup(carolDm)
  carol.net.sendFriendRequest(alice.store.myKey)
  const [, why] = await rejected
  assert.strictEqual(why, 'used')
  assert.ok(!alice.store.isFriend(carol.store.myKey))
  assert.strictEqual(alice.store.friendsInfo().incoming.length, 0)
})

test('storage: deleted and outdated entries are erased from disk and sync as stubs', async (t) => {
  const alice = await makeNode('st-alice')
  alice.store.stubDelay = 0
  const bob = await makeNode('st-bob')
  bob.store.stubDelay = 0
  t.after(async () => { await Promise.all([alice.net.stop(), bob.net.stop()]) })
  const zlib = require('zlib')
  const onDisk = (node, gid) => {
    const dir = path.join(node.store.groupsDir, gid)
    return fs.readdirSync(dir).map((f) => {
      const buf = fs.readFileSync(path.join(dir, f))
      return f.endsWith('.br') ? zlib.brotliDecompressSync(buf).toString() : buf.toString()
    }).join('\n')
  }

  const group = alice.store.createGroup('Stubs')
  alice.net.joinGroup(group)
  const gid = group.id
  for (let i = 0; i < 300; i++) alice.store.append(gid, 'msg', { id: 'n' + i, ch: 'x', text: 'filler message number ' + i })
  alice.store.append(gid, 'msg', { id: 'secret', ch: 'x', text: 'the vault code is quokka' })
  alice.store.append(gid, 'msg.edit', { id: 'n1', text: 'first edit wombat' })
  alice.store.append(gid, 'msg.edit', { id: 'n1', text: 'second edit' })
  const del = alice.store.append(gid, 'msg.delete', { id: 'secret', ch: 'x', at: 0 })
  assert.ok(Array.isArray(del.d.sup) && del.d.sup.length === 1, 'delete supersedes the message')
  const ga = alice.store.groups.get(gid)
  alice.store.compact(ga)
  const disk = onDisk(alice, gid)
  assert.ok(!disk.includes('vault code'), 'deleted text is gone from disk')
  assert.ok(!disk.includes('edit wombat'), 'older edit is gone from disk')
  assert.ok(disk.includes('second edit'))
  const u = alice.store.messageUsage()
  assert.ok(u.stubs >= 2 && u.disk < u.raw, 'stored compressed')

  // reload from disk: same ops, stubs intact
  const reloaded = new Store(alice.store.dir).load()
  assert.strictEqual(reloaded.groups.get(gid).ops.length, ga.ops.length)
  assert.strictEqual(reloaded.groups.get(gid).ops.filter(o => o.k === 'x').length, ga.ops.filter(o => o.k === 'x').length)

  // A 0.3 peer only gets each author's ops up to the first stub (it can't verify stubs)
  const old = alice.store.opsMissingFrom(gid, {}, { stubs: false })
  assert.ok(old.every(o => o.k !== 'x'))
  const firstStub = ga.ops.find(o => o.k === 'x' && o.a === alice.store.myKey).s
  assert.ok(old.filter(o => o.a === alice.store.myKey).every(o => o.s < firstStub))

  // Bob joins and syncs: he gets the stubs (with the ops that justify them), never the text
  const { group: bg } = bob.store.joinGroup(alice.store.inviteFor(gid))
  bob.net.joinGroup(bg)
  await waitFor(() => synced(alice, bob, gid), 25000, 'bob to sync everything')
  const gb = bob.store.groups.get(gid)
  assert.ok(!JSON.stringify(gb.ops).includes('vault code'))
  assert.ok(gb.ops.some(o => o.k === 'x' && o.a === alice.store.myKey))
  assert.strictEqual(texts(bob, gid).length, 300)

  // A live message deleted later is stubbed on bob's side too
  const live = alice.store.append(gid, 'msg', { id: 'oops', ch: 'x', text: 'wrong chat sorry' })
  alice.net.broadcastOps(gid, [live])
  await waitFor(() => texts(bob, gid).includes('wrong chat sorry'), 5000, 'live message')
  const d2 = alice.store.append(gid, 'msg.delete', { id: 'oops', ch: 'x', at: live.t })
  alice.net.broadcastOps(gid, [d2])
  await waitFor(() => !texts(bob, gid).includes('wrong chat sorry'), 5000, 'bob to drop the deleted message')
  bob.store.compact(gb)
  assert.ok(!onDisk(bob, gid).includes('wrong chat'))
})

test('the secret key is sealed on disk, and an account this PC can\'t unlock is never replaced silently', () => {
  const dir = path.join(tmpRoot, 'sealed')
  const seal = (s) => 'X' + Buffer.from(s).toString('base64')
  const unseal = (b) => { if (b[0] !== 'X') throw new Error('nope'); return Buffer.from(b.slice(1), 'base64').toString() }
  const a = new Store(dir).load({ seal, unseal })
  const key = a.myKey
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'))
  assert.ok(onDisk.seedEnc && !onDisk.seed, 'only the sealed seed is stored')
  assert.ok(a.sealed)
  assert.strictEqual(new Store(dir).load({ seal, unseal }).myKey, key)
  // another PC's keychain can't open it
  assert.throws(() => new Store(dir).load({ seal, unseal: () => { throw new Error('DPAPI') } }), (e) => e.code === 'IDENTITY_LOCKED')
  // an old plain seed gets sealed on the next start
  const dir2 = path.join(tmpRoot, 'plain')
  const plain = new Store(dir2).load()
  assert.ok(!plain.sealed)
  assert.strictEqual(new Store(dir2).load({ seal, unseal }).myKey, plain.myKey)
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir2, 'identity.json'), 'utf8')).seedEnc)
  // set aside, not deleted
  const stash = Store.setAside(dir2, 'locked')
  assert.ok(fs.existsSync(path.join(stash, 'identity.json')))
  assert.notStrictEqual(new Store(dir2).load().myKey, plain.myKey)
})

test('backup and restore: password-locked, and restored chats stay read-only until a friend syncs', async (t) => {
  const alice = await makeNode('alice-b')
  const bob = await makeNode('bob-b')
  t.after(async () => { await Promise.all([alice.net.stop(), bob.net.stop()]) })
  const group = alice.store.createGroup('Backups')
  alice.net.joinGroup(group)
  const { group: bg } = bob.store.joinGroup(alice.store.inviteFor(group.id))
  bob.net.joinGroup(bg)
  for (let i = 0; i < 3; i++) alice.net.broadcastOps(group.id, [alice.store.append(group.id, 'msg', { id: 'b' + i, ch: 'x', text: 'before backup ' + i })])
  await waitFor(() => texts(bob, group.id).length === 3, 15000, 'bob to get the messages')

  assert.throws(() => alice.store.exportBackup('short'), /8 characters/)
  const file = alice.store.exportBackup('correct horse battery')
  assert.ok(!file.includes('before backup') && !file.includes(alice.store.seed.toString('hex')), 'nothing readable inside')
  assert.throws(() => Store.openBackup(file, 'wrong password!'), /Wrong password/)
  const b = Store.openBackup(file, 'correct horse battery')
  assert.strictEqual(b.identity.name, 'alice-b')

  // Alice's PC dies; she restores on a new one
  await alice.net.stop()
  const fresh = new Store(path.join(tmpRoot, 'alice-new')).load()
  fresh.restoreBackup(b)
  const restored = new Store(path.join(tmpRoot, 'alice-new')).load()
  assert.strictEqual(restored.myKey, alice.store.myKey)
  const rg = restored.groups.get(group.id)
  assert.ok(rg.restoring)
  // posting now could reuse sequence numbers her friends already have: refused
  assert.throws(() => restored.append(group.id, 'msg', { id: 'z', ch: 'x', text: 'too early' }), (e) => e.code === 'RESTORING')
  const net = new Network(restored, { bootstrap: testnet.bootstrap, authTimeout: 1500 })
  const done = new Promise(resolve => net.on('restored', resolve))
  t.after(() => net.stop())
  await net.start()
  net.joinGroup(rg)
  await done
  assert.ok(!restored.groups.get(group.id).restoring)
  assert.ok(restored.groups.get(group.id).ops.filter(o => o.k === 'msg').length >= 3, 'history came back from bob')
  const op = restored.append(group.id, 'msg', { id: 'after', ch: 'x', text: 'back again' })
  net.broadcastOps(group.id, [op])
  await waitFor(() => texts(bob, group.id).includes('back again'), 10000, 'bob to accept the new message')
})

test('versions: apps too far apart are told who has to update instead of half-syncing', async (t) => {
  const old = await makeNode('old-v')
  const store = new Store(path.join(tmpRoot, 'new-v')).load()
  store.setProfile({ name: 'new-v' })
  const net = new Network(store, { bootstrap: testnet.bootstrap, authTimeout: 1500, proto: 9, minProto: 9 })
  t.after(async () => { await Promise.all([old.net.stop(), net.stop()]) })
  await net.start()
  const group = old.store.createGroup('Versions')
  old.net.joinGroup(group)
  const { group: ng } = store.joinGroup(old.store.inviteFor(group.id))
  net.joinGroup(ng)
  const oldSees = await waitFor(() => old.net.compatInfo()[0], 20000, 'old app to notice')
  const newSees = await waitFor(() => net.compatInfo()[0], 20000, 'new app to notice')
  assert.strictEqual(oldSees.reason, 'update-me')
  assert.strictEqual(newSees.reason, 'update-them')
  assert.deepStrictEqual(oldSees.groups, [group.id])
  assert.strictEqual(old.net.onlinePeers().length, 0, 'no syncing across the gap')
})

test('start with the computer: what the app asks Windows for, and copies that aren\'t installed never ask', () => {
  const { makeAutostart } = require('../src/main/startup')
  const exe = 'C:\\Apps\\OpenDiscord.exe'
  const calls = []
  let entry = null
  // Electron's app on Windows: an entry counts only with the same program and arguments
  const app = {
    getLoginItemSettings: (o) => {
      const on = !!entry && entry.path === o.path && JSON.stringify(entry.args) === JSON.stringify(o.args)
      return { openAtLogin: on, executableWillLaunchAtLogin: on && !entry.off }
    },
    setLoginItemSettings: (o) => { calls.push(o); entry = o.openAtLogin ? { path: o.path, args: o.args } : null }
  }
  let settings = {}
  const auto = makeAutostart({ app, platform: 'win32', exe, supported: true, settings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p } } })
  assert.deepStrictEqual(auto.info(), { supported: true, enabled: false, blocked: false, hidden: true, canHide: true })
  let info = auto.set({ enabled: true })
  assert.deepStrictEqual(calls.at(-1), { openAtLogin: true, path: exe, args: ['--hidden'], enabled: true })
  assert.strictEqual(info.enabled, true)
  info = auto.set({ enabled: true, hidden: false })
  assert.deepStrictEqual(calls.at(-1).args, [])
  assert.strictEqual(info.enabled, true)
  assert.strictEqual(info.hidden, false)
  entry.off = true // switched off in Task Manager
  assert.strictEqual(auto.info().blocked, true)
  assert.strictEqual(auto.set({ enabled: false }).enabled, false)
  const never = () => assert.fail('a copy that is not installed must not touch the system')
  const dev = makeAutostart({ app: { getLoginItemSettings: never, setLoginItemSettings: never }, supported: false, settings: () => ({}), saveSettings: never })
  assert.deepStrictEqual(dev.info(), { supported: false })
  assert.throws(() => dev.set({ enabled: true }), /installed/)
})

test('taskbar icon: an .ico of every size, and only this app\'s shortcuts point at it', () => {
  const { buildIco, refreshShortcuts } = require('../src/main/startup')
  const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n - 4, 7)])
  const ico = buildIco([{ size: 16, png: png(10) }, { size: 256, png: png(20) }])
  assert.strictEqual(ico.readUInt16LE(2), 1) // an icon
  assert.strictEqual(ico.readUInt16LE(4), 2) // two pictures
  assert.strictEqual(ico.readUInt8(6), 16)
  assert.strictEqual(ico.readUInt8(6 + 16), 0) // 256 px is written as 0
  assert.strictEqual(ico.readUInt32LE(6 + 16 + 8), 20)
  const at = ico.readUInt32LE(6 + 16 + 12)
  assert.deepStrictEqual(ico.subarray(at, at + 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.strictEqual(ico.length, 6 + 32 + 10 + 20)
  // small sizes as a classic bitmap: rows bottom-up, transparent pixels marked in the mask
  const bgra = Buffer.from([1, 2, 3, 255, 0, 0, 0, 0, 4, 5, 6, 255, 7, 8, 9, 255]) // 2×2, top right transparent
  const bmp = buildIco([{ size: 2, bgra }])
  const b = bmp.subarray(bmp.readUInt32LE(6 + 12))
  assert.strictEqual(bmp.readUInt32LE(6 + 8), b.length)
  assert.strictEqual(b.readUInt32LE(0), 40)
  assert.strictEqual(b.readInt32LE(8), 4) // twice the height: picture and mask
  assert.deepStrictEqual([...b.subarray(40, 56)], [4, 5, 6, 255, 7, 8, 9, 255, 1, 2, 3, 255, 0, 0, 0, 0])
  assert.deepStrictEqual([...b.subarray(56)], [0, 0, 0, 0, 0x40, 0, 0, 0])

  const dir = fs.mkdtempSync(path.join(tmpRoot, 'lnk-'))
  const links = { 'OpenDiscord.lnk': { target: 'C:\\Apps\\OpenDiscord.exe', icon: 'C:\\Apps\\OpenDiscord.exe' }, 'Other.lnk': { target: 'C:\\Other\\other.exe' } }
  for (const n of [...Object.keys(links), 'notes.txt']) fs.writeFileSync(path.join(dir, n), '')
  const shell = {
    readShortcutLink: (f) => { const l = links[path.basename(f)]; if (!l) throw new Error('not a shortcut'); return { ...l } },
    writeShortcutLink: (f, op, o) => { assert.strictEqual(op, 'update'); Object.assign(links[path.basename(f)], o); return true }
  }
  const file = 'C:\\Users\\x\\AppData\\Roaming\\OpenDiscord\\icons\\OpenDiscord-abc123.ico'
  const changed = refreshShortcuts({ exe: 'c:\\apps\\opendiscord.exe', ico: file, dirs: [dir, path.join(dir, 'missing')], shell })
  assert.deepStrictEqual(changed.map(f => path.basename(f)), ['OpenDiscord.lnk'])
  assert.deepStrictEqual(links['OpenDiscord.lnk'], { target: 'C:\\Apps\\OpenDiscord.exe', icon: file, iconIndex: 0 })
  assert.strictEqual(links['Other.lnk'].icon, undefined)
  // already done: nothing to change (and Explorer isn't asked to reload icons again)
  assert.deepStrictEqual(refreshShortcuts({ exe: 'C:\\Apps\\OpenDiscord.exe', ico: file, dirs: [dir], shell }), [])
})

test('music links: audio files and radio streams play, web pages and walled-off sites don\'t', async () => {
  const { resolveMusicLink, MusicLinks, serveMusicLink } = require('../src/main/musiclink')
  const pages = {
    'https://radio.example/stream': { type: 'audio/mpeg', headers: { 'icy-name': 'Example FM' } },
    'https://files.example/music/My%20Song.mp3': { type: 'audio/mpeg', headers: { 'content-length': '4' } },
    'https://files.example/raw/track.flac': { type: 'application/octet-stream', headers: { 'content-length': '4' } },
    'https://radio.example/listen.pls': { type: 'audio/x-scpls', body: '[playlist]\nNumberOfEntries=1\nFile1=https://radio.example/stream\n' },
    'https://radio.example/live.m3u': { type: 'audio/x-mpegurl', body: '#EXTM3U\n#EXTINF:-1,Example\nhttps://radio.example/stream\n' },
    'https://tv.example/index.m3u8': { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\nchunk.ts\n' },
    'https://blog.example/post': { type: 'text/html', body: '<html></html>' },
    'https://gone.example/x.mp3': { type: 'text/html', status: 404 }
  }
  const asked = []
  const fetch = async (url, o = {}) => {
    asked.push({ url, range: o.headers?.range })
    const p = pages[url]
    if (!p) throw new Error('offline')
    return new Response(p.body ?? 'data', { status: p.status || 200, headers: { 'content-type': p.type, ...p.headers } })
  }
  const r = (url) => resolveMusicLink(url, { fetch })
  assert.deepStrictEqual(await r('https://radio.example/stream'), { url: 'https://radio.example/stream', title: 'Example FM', live: true })
  assert.deepStrictEqual(await r('https://files.example/music/My%20Song.mp3'), { url: 'https://files.example/music/My%20Song.mp3', title: 'My Song', live: false })
  assert.strictEqual((await r('https://files.example/raw/track.flac')).title, 'track')
  assert.strictEqual((await r('https://radio.example/listen.pls')).url, 'https://radio.example/stream')
  assert.strictEqual((await r('https://radio.example/live.m3u')).title, 'Example FM')
  await assert.rejects(r('https://tv.example/index.m3u8'), /HLS/)
  await assert.rejects(r('https://blog.example/post'), /web page/)
  await assert.rejects(r('https://gone.example/x.mp3'), /404/)
  await assert.rejects(r('https://offline.example/a.mp3'), /Couldn't reach/)
  await assert.rejects(r('file:///C:/music/a.mp3'), /http/)
  await assert.rejects(r('not a link'), /isn't a link/)
  const before = asked.length
  await assert.rejects(r('https://www.youtube.com/watch?v=abc'), /YouTube/)
  await assert.rejects(r('https://open.spotify.com/track/abc'), /Spotify/)
  assert.strictEqual(asked.length, before) // never contacted

  // the page only gets audio, and only for links that were checked
  const links = new MusicLinks()
  const media = links.add('https://files.example/music/My%20Song.mp3')
  assert.match(media, /^odweb:\/\/media\/[0-9a-f]{32}$/)
  const req = (url, range) => ({ url, headers: new Headers(range ? { range } : {}) })
  const ok = await serveMusicLink(req(media, 'bytes=2-'), { links, fetch })
  assert.strictEqual(ok.status, 200)
  assert.strictEqual(ok.headers.get('content-type'), 'audio/mpeg')
  assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'odapp://app')
  assert.strictEqual(asked.at(-1).range, 'bytes=2-')
  assert.strictEqual((await serveMusicLink(req('odweb://media/' + 'f'.repeat(32)), { links, fetch })).status, 404)
  const page = links.add('https://blog.example/post')
  assert.strictEqual((await serveMusicLink(req(page), { links, fetch })).status, 415)
})
