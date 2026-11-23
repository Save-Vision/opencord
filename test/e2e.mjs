// End-to-end: two real app instances ("alice", "bob") on a private local DHT.
// Covers onboarding, group invite, chat sync, a P2P image transfer, a voice call
// and a 1080p screen share. Screenshots land in test/screenshots/.
// Run: npm run test:e2e
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const createTestnet = require('hyperdht/testnet')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = path.join(root, 'test', 'screenshots')
fs.mkdirSync(shots, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'od-e2e-'))

const testnet = await createTestnet(4)
const bootstrap = testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(',')
const apps = []
let failed = false

async function launch (name) {
  const app = await electron.launch({
    // OD_EXE=dist/win-unpacked/OpenDiscord.exe tests the packaged build instead of the sources
    executablePath: process.env.OD_EXE ? path.resolve(root, process.env.OD_EXE) : undefined,
    // REAL_CAPTURE=1 uses your real screen/mic instead of Chromium's synthetic test devices
    args: [...(process.env.OD_EXE ? [] : ['.']), `--profile=${name}`, ...(process.env.REAL_CAPTURE ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])],
    cwd: root,
    env: { ...process.env, OD_DATA_DIR: path.join(tmp, name), OD_BOOTSTRAP: bootstrap }
  })
  apps.push(app)
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} ${m.type()}]`, m.text()) })
  await page.setViewportSize({ width: 1320, height: 820 }).catch(() => {})
  return page
}

const step = (s) => console.log('▶', s)
const shot = (page, name) => page.screenshot({ path: path.join(shots, name + '.png') })

try {
  const alice = await launch('alice')
  const bob = await launch('bob')

  step('onboarding')
  for (const [page, name] of [[alice, 'Alice'], [bob, 'Bob']]) {
    await page.getByPlaceholder('What your friends call you').fill(name)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByText(`Hey ${name}!`).waitFor()
  }
  await shot(alice, '01-welcome')

  step('alice creates a group')
  await alice.getByRole('button', { name: 'Create a group' }).click()
  await alice.locator('.modal input').fill('Squad')
  await alice.getByRole('button', { name: 'Create group' }).click()
  const code = (await alice.locator('.invite-box code').textContent()).trim()
  if (!code.startsWith('OD1-')) throw new Error('bad invite code ' + code)
  await shot(alice, '02-invite')
  await alice.getByRole('button', { name: 'Done' }).click()

  step('bob joins with the invite')
  await bob.getByRole('button', { name: 'Join with invite' }).click()
  await bob.locator('.modal textarea').fill(code)
  await bob.getByRole('button', { name: 'Join group' }).click()
  await bob.getByRole('button', { name: 'general', exact: true }).waitFor({ timeout: 30000 })
  await bob.locator('.group-header h1', { hasText: 'Squad' }).waitFor()
  await alice.locator('.member b', { hasText: 'Bob' }).waitFor({ timeout: 15000 })

  step('chat both ways')
  await alice.locator('.composer textarea').fill('hey bob, this is **fully** p2p 🎉')
  await alice.keyboard.press('Enter')
  await bob.locator('.msg .text', { hasText: 'this is fully p2p' }).waitFor({ timeout: 10000 })
  await bob.locator('.composer textarea').fill('works! `no servers`')
  await bob.keyboard.press('Enter')
  await alice.locator('.msg .text', { hasText: 'works!' }).waitFor({ timeout: 10000 })

  step('reaction syncs')
  await bob.locator('.msg', { hasText: 'this is fully p2p' }).hover()
  await bob.locator('.msg', { hasText: 'this is fully p2p' }).locator('.msg-tools button[title="Add reaction"]').dispatchEvent('click')
  await bob.locator('.emoji-picker button', { hasText: '🔥' }).click()
  await alice.locator('.reaction', { hasText: '🔥' }).waitFor({ timeout: 10000 })

  step('image travels peer-to-peer')
  const png = fs.readFileSync(path.join(root, 'build', 'icon.png'))
  await alice.evaluate(async (bytes) => {
    const g = (await window.od.init()).groups[0]
    const ch = g.ops.find(o => o.k === 'channel.create' && o.d.kind === 'text').d.id
    const att = await window.od.importData('three-friends.png', 'image/png', new Uint8Array(bytes))
    await window.od.append(g.id, 'msg', { id: 'img' + Date.now(), ch, text: 'our new icon', att: [{ ...att, w: 512, hh: 512 }] })
  }, [...png])
  await bob.locator('img.att-image').waitFor({ timeout: 20000 })
  await bob.waitForFunction(() => document.querySelector('img.att-image')?.naturalWidth === 512, null, { timeout: 15000 })
  await shot(bob, '03-chat')

  step('settings')
  await alice.locator('.user-panel button[title="Settings"]').click()
  await alice.getByRole('button', { name: 'Privacy & security' }).click()
  await shot(alice, '06-settings')
  await alice.keyboard.press('Escape')

  step('voice call')
  await alice.getByRole('button', { name: 'General', exact: true }).click()
  await bob.getByRole('button', { name: 'General', exact: true }).click()
  const t0 = Date.now()
  await alice.locator('.tile-conn.good').waitFor({ timeout: 45000 })
  await bob.locator('.tile-conn.good').waitFor({ timeout: 45000 })
  console.log(`   call connected in ${Date.now() - t0} ms`)
  await alice.waitForFunction(() => /\d+ ms/.test(document.querySelector('.tile-conn')?.textContent || ''), null, { timeout: 15000 })
  console.log('   alice sees bob:', (await alice.locator('.tile-conn').textContent()).trim())
  console.log('   bob sees alice:', (await bob.locator('.tile-conn').textContent()).trim())

  step('screen share at 1080p60' + (process.env.CODEC ? ' with ' + process.env.CODEC : ''))
  if (process.env.CODEC) {
    await alice.evaluate(async (codec) => { window.__od.model.settings = await window.od.setSettings({ screen: { codec } }) }, process.env.CODEC)
  }
  await alice.locator('.call-controls button[title="Share your screen"]').click()
  await alice.locator('.source').first().waitFor({ timeout: 15000 })
  await alice.locator('.modal select').first().selectOption('1080p60')
  await shot(alice, '07-screen-picker')
  await alice.getByRole('button', { name: 'Go live' }).click()
  await alice.locator('.tile.screen video').waitFor({ timeout: 15000 })
  await bob.locator('.tile.screen video').waitFor({ timeout: 20000 })
  await bob.waitForFunction(() => /\d+×\d+ · \d+ fps/.test(document.querySelector('.tile.screen .tile-stats')?.textContent || ''), null, { timeout: 30000 })
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2500))
    console.log(`   t+${(i + 1) * 2.5}s  alice: ${(await alice.locator('.tile.screen .tile-stats').textContent()).trim()}  |  bob receives: ${(await bob.locator('.tile.screen .tile-stats').textContent()).trim()}`)
  }
  console.log('   encoder:', await alice.evaluate(() => [...window.__od.voice.calls.values()][0]?.stats?.sendScreen?.encoder))
  console.log('   capture:', JSON.stringify(await alice.evaluate(() => { const s = window.__od.voice.local.screen.getVideoTracks()[0].getSettings(); return { w: s.width, h: s.height, fps: s.frameRate } })))
  await shot(bob, '04-screenshare')
  await shot(alice, '05-sharing')

  step('leave call')
  await alice.locator('.call-controls .hangup').click()
  await bob.waitForFunction(() => !document.querySelector('.tile.screen'), null, { timeout: 10000 })

  console.log('\n✅ e2e passed — screenshots in test/screenshots/')
} catch (err) {
  failed = true
  console.error('\n❌ e2e failed:', err.message)
  for (const [i, app] of apps.entries()) {
    try {
      const page = await app.firstWindow()
      await page.screenshot({ path: path.join(shots, `fail-${i}.png`) })
      const rtc = await page.evaluate(async () => {
        const out = []
        for (const c of window.__od?.voice.calls.values() || []) {
          const pairs = []
          const st = await c.pc.getStats()
          st.forEach((r) => {
            if (r.type === 'transport') pairs.push({ transport: r.dtlsState + '/' + r.iceState })
            if (r.type === 'candidate-pair') {
              const l = st.get(r.localCandidateId)
              const rm = st.get(r.remoteCandidateId)
              pairs.push({ state: r.state, nominated: r.nominated, l: `${l?.candidateType} ${l?.address}`, r: `${rm?.candidateType} ${rm?.address}` })
            }
          })
          out.push({ initiator: c.initiator, conn: c.pc.connectionState, ice: c.pc.iceConnectionState, sig: c.pc.signalingState, pairs })
        }
        return out
      })
      console.error(`[app ${i} rtc]`, JSON.stringify(rtc, null, 1))
    } catch {}
  }
} finally {
  for (const app of apps) await app.close().catch(() => {})
  await testnet.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
