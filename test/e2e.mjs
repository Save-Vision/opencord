// End-to-end: two real app instances ("alice", "bob") on a private local DHT.
// Covers onboarding, group invite, chat sync, emoji, pins, file and link previews, a P2P image
// transfer, profile and group pictures, roles, a voice call with mute/move, screen share zoom,
// friends with a private chat and call, and a kick.
// Screenshots land in test/screenshots/.
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

  step('emoji picker and :shortcodes:')
  await alice.locator('.composer .emoji-btn').click()
  await alice.locator('.emoji-panel .ep-emojis button').first().waitFor({ timeout: 10000 })
  console.log('   emoji in picker:', await alice.locator('.emoji-panel .ep-emojis button').count())
  await alice.locator('.emoji-panel .ep-search input').fill('rocket')
  await shot(alice, '10-emoji-picker')
  await alice.locator('.emoji-panel .ep-emojis button', { hasText: '🚀' }).first().click()
  await alice.locator('.composer textarea').focus()
  await alice.keyboard.press('End')
  await alice.keyboard.type(' launch :tad')
  await alice.locator('.emoji-suggest button', { hasText: '🎉' }).first().waitFor({ timeout: 5000 })
  await alice.keyboard.press('Enter')
  const composed = await alice.locator('.composer textarea').inputValue()
  if (!composed.includes('🚀') || !composed.includes('🎉')) throw new Error('emoji not inserted: ' + composed)
  await alice.keyboard.press('Enter')
  await bob.locator('.msg .text', { hasText: 'launch' }).waitFor({ timeout: 10000 })

  step('reaction syncs')
  await bob.locator('.msg', { hasText: 'this is fully p2p' }).hover()
  await bob.locator('.msg', { hasText: 'this is fully p2p' }).locator('.msg-tools button[title="Add reaction"]').dispatchEvent('click')
  await bob.locator('.emoji-panel .ep-search input').fill('fire')
  await bob.locator('.emoji-panel .ep-emojis button', { hasText: '🔥' }).first().click()
  await alice.locator('.reaction', { hasText: '🔥' }).waitFor({ timeout: 10000 })

  step('pin a message')
  await bob.locator('.msg', { hasText: 'this is fully p2p' }).hover()
  await bob.locator('.msg', { hasText: 'this is fully p2p' }).locator('.msg-tools button[title="Pin message"]').dispatchEvent('click')
  await alice.locator('.pins-wrap .count-badge', { hasText: '1' }).waitFor({ timeout: 10000 })
  await alice.locator('.pins-wrap > .icon-btn').click()
  await alice.locator('.pin-item', { hasText: 'this is fully p2p' }).waitFor()
  await shot(alice, '11-pins')
  await alice.locator('.pin-item button', { hasText: 'Jump' }).click()

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

  step('code and markdown files are previewed')
  await alice.evaluate(async ([js, md]) => {
    const enc = (s) => new TextEncoder().encode(s)
    const g = (await window.od.init()).groups.find(x => !x.dm)
    const ch = g.ops.find(o => o.k === 'channel.create' && o.d.kind === 'text').d.id
    const a1 = await window.od.importData('greet.js', 'text/javascript', enc(js))
    const a2 = await window.od.importData('NOTES.md', 'text/markdown', enc(md))
    const op = await window.od.append(g.id, 'msg', { id: 'files' + Date.now(), ch, text: 'some files', att: [a1, a2] })
    window.__od.model.applyOps(g.id, [op])
  }, [
    '// says hi\nexport function greet (name) {\n  const msg = "Hello " + name\n  return msg.length > 3 ? msg : null\n}\n',
    '# Plan for Friday\n\n- [x] fix the **voice** bug\n- [ ] ship 0.3\n\n| who | what |\n|---|---|\n| Bob | snacks |\n\n' + '~~~py\nprint("hi")\n~~~\n'
  ])
  await bob.locator('.text-preview.code .tk-kw', { hasText: 'function' }).first().waitFor({ timeout: 20000 })
  await bob.locator('.text-preview.md h1', { hasText: 'Plan for Friday' }).waitFor({ timeout: 20000 })
  await bob.locator('.text-preview.md td', { hasText: 'snacks' }).waitFor()
  await bob.locator('.text-preview.md .tk-str', { hasText: '"hi"' }).waitFor()
  await shot(bob, '12-file-previews')

  step('link preview (needs internet)')
  await alice.locator('.composer textarea').fill('look https://github.com/electron/electron')
  await alice.keyboard.press('Enter')
  try {
    await bob.locator('.embed .embed-title').first().waitFor({ timeout: 25000 })
    console.log('   preview:', (await bob.locator('.embed .embed-title').first().textContent()).trim().slice(0, 70))
    await shot(bob, '13-link-preview')
  } catch { console.log('   ⚠ no link preview arrived (offline?)') }

  step('profile picture')
  await alice.locator('.user-panel button[title="Settings"]').click()
  await alice.locator('.profile-editor input[type=file]').setInputFiles(path.join(root, 'build', 'icon.png'))
  const crop = await alice.locator('.crop-view').boundingBox()
  await alice.mouse.move(crop.x + crop.width / 2, crop.y + crop.height / 2)
  await alice.mouse.wheel(0, -400)
  await alice.mouse.down()
  await alice.mouse.move(crop.x + crop.width / 2 + 50, crop.y + crop.height / 2 + 30, { steps: 6 })
  await alice.mouse.up()
  await shot(alice, '08-avatar-crop')
  await alice.getByRole('button', { name: 'Apply', exact: true }).click()
  await alice.getByRole('button', { name: 'Save', exact: true }).click()
  await alice.locator('.user-panel .avatar img').waitFor({ timeout: 5000 })
  await bob.locator('.msg-avatar img').first().waitFor({ timeout: 10000 })
  await bob.locator('.member .avatar img').first().waitFor({ timeout: 5000 })
  console.log('   avatar synced to bob:', await bob.evaluate(() => { const s = document.querySelector('.msg-avatar img').src; return s.slice(0, 22) + '… ' + s.length + ' chars' }))
  await alice.keyboard.press('Escape')
  await shot(bob, '09-avatar-synced')

  step('group picture')
  await alice.locator('.group-header').click()
  await alice.locator('.dropdown button', { hasText: 'Change group picture' }).click()
  await alice.locator('.modal input[type=file]').setInputFiles(path.join(root, 'build', 'icon.png'))
  await alice.locator('.crop-view').waitFor()
  await alice.getByRole('button', { name: 'Apply', exact: true }).click()
  await alice.locator('.rail-btn img.group-icon').waitFor({ timeout: 5000 })
  await bob.locator('.rail-btn img.group-icon').waitFor({ timeout: 10000 })
  await shot(bob, '14-group-picture')

  step('settings')
  await alice.locator('.user-panel button[title="Settings"]').click()
  await alice.getByRole('button', { name: 'Privacy & security' }).click()
  await shot(alice, '06-settings')
  await alice.getByRole('button', { name: 'Network', exact: true }).click()
  await alice.locator('.net-item', { hasText: 'connected' }).first().waitFor({ timeout: 10000 })
  console.log('   connection check:', (await alice.locator('.net-item b').allTextContents()).join(' | '))
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  await alice.locator('table.peers td', { hasText: version }).waitFor({ timeout: 5000 })
  await alice.getByRole('button', { name: 'Updates', exact: true }).click()
  console.log('   updates tab:', (await alice.locator('.update-status').textContent()).trim())
  await alice.getByRole('button', { name: 'Network', exact: true }).click()
  await shot(alice, '06b-network')
  await alice.getByRole('button', { name: 'Storage', exact: true }).click()
  await alice.locator('.settings-body .hint', { hasText: 'used' }).waitFor({ timeout: 10000 })
  console.log('   storage:', (await alice.locator('.settings-body .invite-box code').textContent()).trim(), '·', (await alice.locator('.settings-body .hint', { hasText: 'used' }).textContent()).trim())
  await shot(alice, '15-storage')
  await alice.getByRole('button', { name: 'Voice & audio', exact: true }).click()
  console.log('   noise suppression:', await alice.locator('.settings-body select:has(option[value="ai"])').inputValue())
  await alice.keyboard.press('Escape')

  step('owner makes bob an admin')
  await alice.locator('.member', { hasText: 'Bob' }).click({ button: 'right' })
  await alice.locator('.ctx-menu').waitFor()
  await shot(alice, '16-member-menu')
  await alice.locator('.ctx-menu button', { hasText: 'Make admin' }).click()
  await bob.locator('.member', { hasText: 'Bob' }).locator('.role.admin').waitFor({ timeout: 10000 })
  await bob.locator('.member', { hasText: 'Alice' }).locator('.role.owner').waitFor()
  await alice.evaluate(async () => {
    const g = window.__od.model.groupsList()[0]
    const op = await window.od.append(g.id, 'channel.create', { id: 'lounge1', name: 'Lounge', kind: 'voice' })
    window.__od.model.applyOps(g.id, [op])
  })

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
  console.log('   AI noise suppression active:', await alice.evaluate(() => window.__od.voice.denoised), '/', await bob.evaluate(() => window.__od.voice.denoised))

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

  step('zoom into the screen share')
  const zbox = await bob.locator('.tile.screen .zoom-wrap').first().boundingBox()
  await bob.mouse.move(zbox.x + zbox.width * 0.7, zbox.y + zbox.height * 0.3)
  await bob.mouse.wheel(0, -500)
  await bob.waitForFunction(() => parseInt(document.querySelector('.zoom-pct')?.textContent) > 150, null, { timeout: 5000 })
  await bob.mouse.down()
  await bob.mouse.move(zbox.x + zbox.width * 0.5, zbox.y + zbox.height * 0.5, { steps: 5 })
  await bob.mouse.up()
  console.log('   zoom:', (await bob.locator('.zoom-pct').textContent()).trim(), await bob.locator('.zoom-inner').evaluate(el => el.style.transform))
  await shot(bob, '17-zoomed')
  await bob.locator('.zoom-pct').click()

  step('moderation: mute for everyone, then move')
  await alice.locator('.tile.person', { hasText: 'Bob' }).click({ button: 'right' })
  await alice.locator('.ctx-menu button', { hasText: 'Mute for everyone' }).click()
  await bob.waitForFunction(() => window.__od.voice.serverMuted === true, null, { timeout: 10000 })
  await alice.locator('.tile.person', { hasText: 'Bob' }).locator('.server-mute').waitFor({ timeout: 5000 })
  console.log('   bob mic track enabled while muted:', await bob.evaluate(() => window.__od.voice.local.mic.getAudioTracks()[0].enabled))
  await shot(alice, '18-server-muted')
  await alice.locator('.tile.person', { hasText: 'Bob' }).click({ button: 'right' })
  await alice.locator('.ctx-menu button', { hasText: 'Unmute for everyone' }).click()
  await bob.waitForFunction(() => window.__od.voice.serverMuted === false, null, { timeout: 10000 })
  await alice.locator('.tile.person', { hasText: 'Bob' }).click({ button: 'right' })
  await alice.locator('.ctx-menu button', { hasText: 'Move to' }).click()
  await alice.locator('.ctx-sub button', { hasText: 'Lounge' }).click()
  await bob.waitForFunction(() => window.__od.voice.active?.ch === 'lounge1', null, { timeout: 10000 })
  console.log('   bob was moved to Lounge')

  step('leave call')
  await alice.locator('.call-controls .hangup').click()
  await bob.evaluate(() => window.__od.voice.leave())

  step('friends: request by friend code, accept, private chat')
  await alice.locator('.rail-btn.home').click()
  await alice.locator('.friends-tabs button.add').click()
  const friendCode = (await alice.locator('.add-friend .invite-box code').textContent()).trim()
  if (!friendCode.startsWith('ODF1-')) throw new Error('bad friend code ' + friendCode)
  await shot(alice, '19-add-friend')
  await bob.locator('.rail-btn.home').click()
  await bob.locator('.friends-tabs button.add').click()
  await bob.locator('.add-row input').fill(friendCode)
  await bob.getByRole('button', { name: 'Send friend request' }).click()
  await alice.locator('.friends-tabs .badge').waitFor({ timeout: 20000 })
  await alice.locator('.friends-tabs button', { hasText: 'Pending' }).click()
  await shot(alice, '20-friend-request')
  await alice.locator('.round-btn[title="Accept"]').click()
  await alice.locator('.chat-header h2', { hasText: 'Bob' }).waitFor({ timeout: 5000 })
  await alice.locator('.chat-header .presence.online').waitFor({ timeout: 10000 })
  await bob.locator('.dm-item:not(.pending)', { hasText: 'Alice' }).waitFor({ timeout: 20000 })
  await bob.locator('.dm-item', { hasText: 'Alice' }).click()
  await bob.locator('.composer textarea').fill('just between us 🤫')
  await bob.keyboard.press('Enter')
  await alice.locator('.msg .text', { hasText: 'just between us' }).waitFor({ timeout: 10000 })
  await shot(alice, '21-private-chat')

  step('private call')
  await alice.locator('.chat-header button[title="Start a call"]').click()
  await bob.locator('.call-banner').waitFor({ timeout: 10000 })
  await shot(bob, '22-incoming-call')
  await bob.locator('.call-banner .round-btn[title="Accept"]').click()
  await alice.locator('.tile-conn.good').waitFor({ timeout: 45000 })
  await bob.locator('.tile-conn.good').waitFor({ timeout: 45000 })
  console.log('   private call connected:', (await alice.locator('.tile-conn').textContent()).trim())
  await shot(alice, '23-private-call')
  await alice.locator('.call-controls .hangup').click()
  await bob.evaluate(() => window.__od.voice.leave())

  step('kick')
  await alice.locator('.rail-btn[title="Squad"]').click()
  await alice.locator('.member', { hasText: 'Bob' }).click({ button: 'right' })
  await alice.locator('.ctx-menu button', { hasText: 'Kick Bob' }).click()
  await alice.locator('.modal footer button', { hasText: 'Kick' }).click()
  await bob.locator('.rail-btn[title="Squad"]').click()
  await bob.locator('.removed-banner').waitFor({ timeout: 15000 })
  await alice.waitForFunction(() => ![...document.querySelectorAll('.member b')].some(b => b.textContent.includes('Bob')), null, { timeout: 10000 })
  await shot(bob, '24-kicked')
  await bob.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 9000 })

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
