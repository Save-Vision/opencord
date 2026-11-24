// End-to-end: two real app instances ("alice", "bob") on a private local DHT.
// Covers onboarding, one-time group invite links, chat sync, threads, emoji, pins, file and link
// previews, a P2P image transfer, profile and group pictures, the shared calendar and task board,
// roles, a voice call with mute/move, opt-in screen watching with viewers and zoom, friend links
// with a private chat and call, and a kick. Since 0.5: channel folders, a chess game, @claude
// against a stand-in for the Anthropic API, and checks that a muted mic sends nothing and that
// forged voice messages can't open a call. Since 0.6: search, profile cards, polls, status,
// Claude's privacy (it only reads the asker) and replies to Claude, the soundboard, a poker hand,
// a call over the fallback path, the update-required screen, and restoring a backup. Since 0.6.1:
// the themes, moving and resizing the floating panels. Since 0.6.2: light and dark modes, the
// Minimal theme, and two people writing in one focus document at once; Bob uses Glass (light)
// from then on.
// Screenshots land in test/screenshots/.
// Run: npm run test:e2e
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'module'
import fs from 'fs'
import http from 'http'
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

// A stand-in for the Anthropic API on this PC, so @claude is tested without a real key or cost
const TEST_KEY = 'sk-ant-test-' + 'k'.repeat(28)
const claudeLog = []
const claudeMock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    // SDK 1.x sends the key as a bearer token; older ones used x-api-key
    const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '')
    claudeLog.push({ method: req.method, path: req.url, key, body })
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (key !== TEST_KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      return json(200, { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' })
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const r = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const ev = (type, data = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: r.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 420, output_tokens: 1 } } })
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const w of ['**P2P** means ', 'peer-to-peer: ', 'your PCs talk ', 'to each other directly, ', 'with no server in between.']) {
        await new Promise(resolve => setTimeout(resolve, 400))
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: w } })
      }
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 24 } })
      ev('message_stop')
      return res.end()
    }
    json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } })
  })
})
await new Promise(resolve => claudeMock.listen(0, '127.0.0.1', resolve))
const claudeURL = `http://127.0.0.1:${claudeMock.address().port}`

async function launch (name) {
  const app = await electron.launch({
    // OD_EXE=dist/win-unpacked/OpenDiscord.exe tests the packaged build instead of the sources
    executablePath: process.env.OD_EXE ? path.resolve(root, process.env.OD_EXE) : undefined,
    // REAL_CAPTURE=1 uses your real screen/mic instead of Chromium's synthetic test devices
    args: [...(process.env.OD_EXE ? [] : ['.']), `--profile=${name}`, ...(process.env.REAL_CAPTURE ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])],
    cwd: root,
    env: { ...process.env, OD_DATA_DIR: path.join(tmp, name), OD_BOOTSTRAP: bootstrap, OD_CLAUDE_BASE_URL: claudeURL }
  })
  apps.push(app)
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} ${m.type()}]`, m.text()) })
  await page.setViewportSize({ width: 1320, height: 820 }).catch(() => {})
  return page
}

const step = (s) => console.log('▶', s)
// A text channel's row also holds its unread badge, so find it by its name
const openChannel = (page, name) => page.locator('.channel .ch-name').getByText(name, { exact: true }).click()
const shot = (page, name) => page.screenshot({ path: path.join(shots, name + '.png') })
// let pop-in animations finish so screenshots show the finished screen
const settle = (page) => page.waitForTimeout(400)

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
  await alice.getByRole('button', { name: 'Create invite link' }).click()
  const code = (await alice.locator('.invite-box code').textContent()).trim()
  if (!code.startsWith('opendiscord://join/')) throw new Error('bad invite link ' + code)
  await alice.locator('.invite-row').waitFor()
  await shot(alice, '02-invite')
  await alice.getByRole('button', { name: 'Done' }).click()

  step('bob clicks the one-time link')
  // what happens when the link is clicked in another app (opendiscord:// opens the app)
  await bob.evaluate((url) => window.__od.model.openModal('openLink', { url }), code)
  await bob.locator('.link-card h2', { hasText: 'Join Squad?' }).waitFor({ timeout: 5000 })
  await bob.getByRole('button', { name: 'Join group' }).click()
  await bob.getByRole('button', { name: 'general', exact: true }).waitFor({ timeout: 30000 })
  await bob.locator('.group-header h1', { hasText: 'Squad' }).waitFor()
  await alice.locator('.member b', { hasText: 'Bob' }).waitFor({ timeout: 15000 })
  const again = await bob.evaluate((link) => window.od.joinGroup(link), code)
  if (!again.existed || again.pending) throw new Error('opening the link again should say "already in this group"')

  step('chat both ways')
  await alice.locator('.composer textarea').fill('hey bob, this is **fully** p2p 🎉')
  await alice.keyboard.press('Enter')
  await bob.locator('.msg .text', { hasText: 'this is fully p2p' }).waitFor({ timeout: 10000 })
  await bob.locator('.composer textarea').fill('works! `no servers`')
  await bob.keyboard.press('Enter')
  await alice.locator('.msg .text', { hasText: 'works!' }).waitFor({ timeout: 10000 })

  step('thread')
  await bob.locator('.msg', { has: bob.locator('.text', { hasText: 'this is fully p2p' }) }).hover()
  await bob.locator('.msg', { has: bob.locator('.text', { hasText: 'this is fully p2p' }) }).locator('.thread-btn').click()
  await bob.locator('.thread-panel textarea').fill('replying in a thread 🧵')
  await bob.keyboard.press('Enter')
  await bob.locator('.thread-panel .msg .text', { hasText: 'replying in a thread' }).waitFor({ timeout: 5000 })
  await alice.locator('.thread-summary', { hasText: '1 reply' }).waitFor({ timeout: 10000 })
  if (await alice.locator('.messages .msg .text', { hasText: 'replying in a thread' }).count()) throw new Error('thread reply leaked into the channel')
  await alice.locator('.thread-summary').click()
  await alice.locator('.thread-panel .msg .text', { hasText: 'replying in a thread' }).waitFor({ timeout: 5000 })
  await alice.locator('.thread-panel .also-send input').check()
  await alice.locator('.thread-panel textarea').fill('also in the channel')
  await alice.keyboard.press('Enter')
  await bob.locator('.thread-summary', { hasText: '2 replies' }).waitFor({ timeout: 10000 })
  await bob.locator('.messages .msg .text', { hasText: 'also in the channel' }).waitFor({ timeout: 10000 })
  await shot(alice, '25-thread')
  await alice.locator('.thread-panel header button[title="Close thread"]').click()
  await bob.locator('.thread-panel header button[title="Close thread"]').click()

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
  await bob.locator('.msg', { has: bob.locator('.text', { hasText: 'this is fully p2p' }) }).hover()
  await bob.locator('.msg', { has: bob.locator('.text', { hasText: 'this is fully p2p' }) }).locator('.msg-tools button[title="Add reaction"]').dispatchEvent('click')
  await bob.locator('.emoji-panel .ep-search input').fill('fire')
  await bob.locator('.emoji-panel .ep-emojis button', { hasText: '🔥' }).first().click()
  await alice.locator('.reaction', { hasText: '🔥' }).waitFor({ timeout: 10000 })

  step('pin a message')
  await bob.locator('.msg', { has: bob.locator('.text', { hasText: 'this is fully p2p' }) }).hover()
  await bob.locator('.msg', { has: bob.locator('.text', { hasText: 'this is fully p2p' }) }).locator('.msg-tools button[title="Pin message"]').dispatchEvent('click')
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
  // the running app's own version: CI builds it with the release number, not package.json's
  const version = await alice.evaluate(() => window.__od.model.version)
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('app reports no version: ' + version)
  await alice.locator('table.peers td', { hasText: version }).waitFor({ timeout: 5000 })
  await alice.getByRole('button', { name: 'Updates', exact: true }).click()
  console.log('   updates tab:', (await alice.locator('.update-status').textContent()).trim())
  await alice.getByRole('button', { name: 'Network', exact: true }).click()
  await shot(alice, '06b-network')
  await alice.getByRole('button', { name: 'Storage', exact: true }).click()
  await alice.locator('.settings-body .hint', { hasText: 'used' }).waitFor({ timeout: 10000 })
  console.log('   storage:', (await alice.locator('.settings-body .invite-box code').textContent()).trim(), '·', (await alice.locator('.settings-body .hint', { hasText: 'used' }).textContent()).trim())
  console.log('   messages:', (await alice.locator('.usage-rows > div').first().textContent()).trim())
  await shot(alice, '15-storage')
  await alice.getByRole('button', { name: 'Voice & audio', exact: true }).click()
  console.log('   noise suppression:', await alice.locator('.settings-body select:has(option[value="ai"])').inputValue())

  step('themes: each one changes the whole window and is saved, in light and dark')
  await alice.getByRole('button', { name: 'Appearance', exact: true }).click()
  const mode = (page) => page.evaluate(() => document.documentElement.dataset.mode)
  for (const [i, t] of ['minimal', 'xp', 'glass', 'oled', 'standard'].entries()) {
    await alice.locator(`.theme-card[data-theme-id="${t}"]`).click()
    await alice.locator(`html[data-theme="${t}"]`).waitFor({ state: 'attached', timeout: 5000 })
    await alice.locator(`.theme-card.active[data-theme-id="${t}"]`).waitFor()
    if (await alice.evaluate(() => window.__od.model.settings.theme) !== t) throw new Error('theme not saved: ' + t)
    const look = await alice.evaluate(() => ({
      font: getComputedStyle(document.body).fontFamily.split(',')[0],
      icon: document.querySelector('.user-panel svg.icon')?.getAttribute('class')
    }))
    console.log(`   ${t} (${await mode(alice)}): font ${look.font}, ${look.icon}`)
    if (t === 'glass' && !(await alice.locator('.toggle-row', { hasText: 'Moving background' }).isVisible())) throw new Error('Glass should offer the moving background switch')
    if (t !== 'standard') {
      await alice.keyboard.press('Escape')
      await settle(alice)
      await shot(alice, `${49 + i}-theme-${t}`)
      await alice.locator('.user-panel button[title="Settings"]').click()
      await alice.getByRole('button', { name: 'Appearance', exact: true }).click()
    }
  }
  // every theme has a light and a dark mode
  for (const [t, m] of [['oled', 'light'], ['xp', 'dark'], ['standard', 'light'], ['standard', 'dark']]) {
    await alice.locator(`.theme-card[data-theme-id="${t}"]`).click()
    await alice.locator(`.seg button[data-mode-id="${m}"]`).click()
    await alice.locator(`html[data-theme="${t}"][data-mode="${m}"]`).waitFor({ state: 'attached', timeout: 5000 })
    if (await alice.evaluate(() => window.__od.model.settings.mode) !== m) throw new Error('mode not saved: ' + m)
    if (t !== 'standard' || m !== 'dark') {
      await alice.keyboard.press('Escape')
      await settle(alice)
      await shot(alice, `55-theme-${t}-${m}`)
      await alice.locator('.user-panel button[title="Settings"]').click()
      await alice.getByRole('button', { name: 'Appearance', exact: true }).click()
    }
  }
  await alice.keyboard.press('Escape')
  // Bob keeps Glass in light mode for the rest of the run, so calls and everything else are
  // also checked in a light theme
  await bob.locator('.user-panel button[title="Settings"]').click()
  await bob.getByRole('button', { name: 'Appearance', exact: true }).click()
  await bob.locator('.theme-card[data-theme-id="glass"]').click()
  await bob.locator('html[data-theme="glass"][data-mode="light"]').waitFor({ state: 'attached' })
  await bob.keyboard.press('Escape')

  step('panels: drag the side panel next to the channels, resize, cancel, reset')
  const layoutOf = (page) => page.evaluate(() => window.__od.model.settings.layout)
  const box = (page, sel) => page.locator(sel).boundingBox()
  const grip = await box(alice, '.dock-side > .dock-grip')
  const nav = await box(alice, '.dock-nav')
  await alice.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await alice.mouse.down()
  await alice.mouse.move(nav.x + 30, nav.y + nav.height / 2, { steps: 10 })
  await alice.locator('.dock-nav.drop-before').waitFor({ timeout: 3000 })
  await alice.locator('.dock-ghost.ok', { hasText: 'left of channels' }).waitFor()
  await shot(alice, '53-panel-drag')
  await alice.mouse.up()
  await alice.waitForFunction(() => window.__od.model.settings.layout?.order?.join() === 'rail,side,nav,main', null, { timeout: 5000 })
  if (!((await box(alice, '.dock-side')).x < (await box(alice, '.dock-nav')).x)) throw new Error('the side panel should now be left of the channels')
  // the chat survived the move (same DOM, only the CSS order changed)
  await alice.locator('.dock-main .composer textarea').waitFor()
  await settle(alice)
  await shot(alice, '54-panel-moved')
  // Escape cancels a drag
  const grip2 = await box(alice, '.dock-main > .dock-grip')
  const rail = await box(alice, '.dock-rail')
  await alice.mouse.move(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2)
  await alice.mouse.down()
  await alice.mouse.move(rail.x + 10, rail.y + 200, { steps: 6 })
  await alice.locator('.dock-rail.drop-before').waitFor({ timeout: 3000 })
  await alice.keyboard.press('Escape')
  await alice.mouse.up()
  await alice.waitForTimeout(300)
  if ((await layoutOf(alice)).order.join() !== 'rail,side,nav,main') throw new Error('Escape should cancel the move')
  // resize the channel list: 248 + 30 snaps to 280
  const edge = await box(alice, '.dock-nav > .dock-resize')
  await alice.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await alice.mouse.down()
  await alice.mouse.move(edge.x + edge.width / 2 + 30, edge.y + edge.height / 2, { steps: 6 })
  await alice.locator('.dock-size', { hasText: '280 px' }).waitFor({ timeout: 3000 })
  await alice.mouse.up()
  await alice.waitForFunction(() => window.__od.model.settings.layout?.w?.nav === 280, null, { timeout: 5000 })
  if (Math.round((await box(alice, '.dock-nav')).width) !== 280) throw new Error('the channel list should be 280 px wide')
  // double-click the edge for the default width
  await alice.locator('.dock-nav > .dock-resize').dblclick()
  await alice.waitForFunction(() => !window.__od.model.settings.layout?.w?.nav, null, { timeout: 5000 })
  // reset everything from settings
  await alice.locator('.user-panel button[title="Settings"]').click()
  await alice.getByRole('button', { name: 'Appearance', exact: true }).click()
  await alice.getByRole('button', { name: 'Reset panels' }).click()
  await alice.waitForFunction(() => window.__od.model.settings.layout?.order?.join() === 'rail,nav,main,side', null, { timeout: 5000 })
  await alice.keyboard.press('Escape')

  step('focus docs: write in one document together, nothing else on screen')
  await alice.locator('.docs-link').click()
  await alice.getByRole('button', { name: 'New document' }).click()
  await alice.locator('.focus-mode .focus-text').waitFor()
  if (await alice.locator('.dock-main').isVisible() && await alice.locator('.focus-mode').evaluate(el => el.getBoundingClientRect().width < window.innerWidth)) throw new Error('focus mode should cover the window')
  await alice.locator('.focus-title').fill('Trip plan')
  await alice.locator('.focus-title').press('Enter')
  await alice.locator('.focus-text').click()
  await alice.keyboard.type('# Trip plan\n\nAlice: we leave on Friday.\n')
  await bob.locator('.docs-link').click()
  await bob.locator('.doc-card', { hasText: 'Trip plan' }).click({ timeout: 15000 })
  const docText = (page) => page.locator('.focus-text').inputValue()
  await bob.waitForFunction(() => document.querySelector('.focus-text')?.value.includes('we leave on Friday'), null, { timeout: 15000 })
  // both type at the same time: Alice at the end, Bob at the very start
  await bob.locator('.focus-text').click()
  await bob.keyboard.press('Control+Home')
  await Promise.all([
    alice.keyboard.type('Alice: I bring the tent.\n', { delay: 25 }),
    bob.keyboard.type('Bob was here first. ', { delay: 25 })
  ])
  const same = async () => {
    for (let k = 0; k < 60; k++) {
      const [a, b] = [await docText(alice), await docText(bob)]
      if (a === b && a.includes('I bring the tent') && a.includes('Bob was here first')) return a
      await alice.waitForTimeout(250)
    }
    throw new Error('the two apps did not end up with the same text:\n' + await docText(alice) + '\n---\n' + await docText(bob))
  }
  const merged = await same()
  if (!merged.startsWith('Bob was here first. # Trip plan') || !merged.endsWith('Alice: I bring the tent.\n')) throw new Error('edits landed in the wrong place: ' + JSON.stringify(merged))
  // Bob's caret stayed where he was typing while Alice's text came in
  if (await bob.locator('.focus-text').evaluate(el => el.selectionStart) !== 'Bob was here first. '.length) throw new Error("Bob's caret moved")
  // each sees the other in the document
  await alice.locator('.focus-people .avatar').first().waitFor({ timeout: 10000 })
  await bob.locator('.focus-people .avatar').first().waitFor({ timeout: 10000 })
  await bob.getByRole('button', { name: 'Split', exact: true }).click()
  // (Bob's words now start the first line, so "# Trip plan" is no longer a heading)
  await bob.locator('.focus-preview p', { hasText: 'I bring the tent' }).waitFor({ timeout: 5000 })
  await alice.mouse.move(400, 300)
  await settle(alice)
  await shot(alice, '56-focus-alice')
  await shot(bob, '57-focus-bob')
  // Esc leaves focus mode; the document is in the list for both
  await alice.keyboard.press('Escape')
  await alice.locator('.doc-card', { hasText: 'Trip plan' }).waitFor()
  await bob.keyboard.press('Escape')
  await bob.locator('.doc-card', { hasText: 'Trip plan' }).waitFor()
  console.log('   doc words:', merged.split(/\s+/).filter(Boolean).length)
  await openChannel(alice, 'general')
  await openChannel(bob, 'general')

  step('calendar: event with RSVP')
  await alice.locator('.planner-link', { hasText: 'Calendar' }).click()
  await alice.getByRole('button', { name: 'New event' }).click()
  await alice.locator('.planner-form input').first().fill('Game night')
  await alice.locator('.planner-form input[type="time"]').fill('23:30')
  await alice.getByRole('button', { name: 'Add event' }).click()
  await alice.locator('.cal-chip', { hasText: 'Game night' }).waitFor({ timeout: 5000 })
  await bob.locator('.planner-link', { hasText: 'Calendar' }).click()
  await bob.locator('.up-item', { hasText: 'Game night' }).waitFor({ timeout: 10000 })
  await bob.locator('.up-item', { hasText: 'Game night' }).getByRole('button', { name: 'Going' }).click()
  await alice.locator('.up-item', { hasText: 'Game night' }).locator('.avatar-stack .avatar').nth(1).waitFor({ timeout: 10000 })
  await alice.locator('.cal-chip', { hasText: 'Game night' }).click()
  await alice.locator('.rsvp-row', { hasText: 'Going' }).locator('.rsvp-person', { hasText: 'Bob' }).waitFor({ timeout: 5000 })
  await alice.waitForTimeout(400) // let the modal finish animating in
  await shot(alice, '26-event')
  await alice.keyboard.press('Escape')
  await shot(bob, '27-calendar')

  step('tasks: add, assign, checklist, move')
  await alice.locator('.planner-link', { hasText: 'Tasks' }).click()
  await alice.locator('.quick-add input').fill('Buy snacks')
  await alice.keyboard.press('Enter')
  await bob.locator('.planner-link', { hasText: 'Tasks' }).click()
  await bob.locator('.task-card', { hasText: 'Buy snacks' }).click()
  await bob.locator('.status-tabs button', { hasText: 'Doing' }).click()
  await bob.locator('.planner-form select').first().selectOption({ label: 'Bob (you)' })
  await bob.locator('.cl-add input').fill('chips')
  await bob.keyboard.press('Enter')
  await bob.locator('.cl-add input').fill('lemonade')
  await bob.keyboard.press('Enter')
  await bob.getByRole('button', { name: 'Save', exact: true }).click()
  const doing = alice.locator('.board-col').nth(1)
  await doing.locator('.task-card', { hasText: 'Buy snacks' }).locator('.checks', { hasText: '0/2' }).waitFor({ timeout: 10000 })
  await doing.locator('.task-card', { hasText: 'Buy snacks' }).locator('.task-who').waitFor()
  await bob.locator('.planner-link', { hasText: 'Tasks' }).locator('.soft-badge', { hasText: '1' }).waitFor({ timeout: 5000 })
  await shot(alice, '28-tasks')
  await alice.locator('.task-card', { hasText: 'Buy snacks' }).dragTo(alice.locator('.board-col').nth(2))
  await bob.locator('.board-col').nth(2).locator('.task-card', { hasText: 'Buy snacks' }).waitFor({ timeout: 10000 })
  await alice.getByRole('button', { name: 'general', exact: true }).click()
  await bob.getByRole('button', { name: 'general', exact: true }).click()

  step('folders: create one, put channels in, both see the same tree')
  await alice.locator('.group-header').click()
  await alice.locator('.dropdown button', { hasText: 'Create folder' }).click()
  await alice.locator('.modal input').fill('Gaming')
  await alice.locator('.modal footer').getByRole('button', { name: 'Create' }).click()
  const aFolder = alice.locator('.folder', { has: alice.locator('.folder-head', { hasText: 'Gaming' }) })
  await aFolder.waitFor({ timeout: 5000 })
  await aFolder.locator('.folder-head').hover()
  await aFolder.locator('button[title="Create channel in this folder"]').click()
  await alice.locator('.modal input').first().fill('minecraft')
  await alice.locator('.modal footer').getByRole('button', { name: 'Create' }).click()
  await aFolder.locator('.channel', { hasText: 'minecraft' }).waitFor({ timeout: 5000 })
  await alice.getByRole('button', { name: 'General', exact: true }).dragTo(aFolder.locator('.folder-head'))
  const bFolder = bob.locator('.folder', { has: bob.locator('.folder-head', { hasText: 'Gaming' }) })
  await bFolder.locator('.channel', { hasText: 'minecraft' }).waitFor({ timeout: 10000 })
  await bFolder.getByRole('button', { name: 'General', exact: true }).waitFor({ timeout: 10000 })
  await shot(bob, '30-folders')
  await bFolder.locator('.folder-name').click()
  await bFolder.locator('.channel', { hasText: 'minecraft' }).waitFor({ state: 'detached', timeout: 5000 })
  await bFolder.locator('.folder-name').click()
  await bFolder.locator('.channel', { hasText: 'minecraft' }).waitFor({ timeout: 5000 })
  await openChannel(alice, 'general')

  step('chess: challenge, accept, play, agree a draw')
  await alice.locator('.chat-header button[title="Play a game in this channel"]').click()
  await alice.locator('.modal select').first().selectOption({ label: 'Bob' })
  await shot(alice, '31-new-game')
  await alice.getByRole('button', { name: 'Send challenge' }).click()
  await alice.locator('.chess-board').waitFor({ timeout: 5000 })
  await bob.locator('.game-card').getByRole('button', { name: 'Accept' }).click({ timeout: 15000 })
  await bob.locator('.chess-board').waitFor({ timeout: 5000 })
  await alice.locator('.game-status', { hasText: 'Your move' }).waitFor({ timeout: 10000 })
  await alice.locator('[data-sq="e2"]').click()
  await alice.locator('[data-sq="e4"]').click()
  await bob.locator('.mv', { hasText: 'e4' }).waitFor({ timeout: 10000 })
  await bob.locator('[data-sq="e7"]').click()
  await bob.locator('[data-sq="e5"]').click()
  await alice.locator('.mv', { hasText: 'e5' }).waitFor({ timeout: 10000 })
  await alice.locator('[data-sq="g1"]').dragTo(alice.locator('[data-sq="f3"]'))
  await bob.locator('.mv', { hasText: 'Nf3' }).waitFor({ timeout: 10000 })
  await bob.locator('[data-sq="e8"]').click() // the king can't go to e6: nothing happens
  await bob.locator('[data-sq="e6"]').click()
  await bob.waitForTimeout(500)
  if (await bob.locator('.mv').count() !== 3) throw new Error('an illegal move was played')
  await bob.locator('[data-sq="b8"]').click()
  await bob.locator('[data-sq="c6"]').click()
  await alice.locator('.mv', { hasText: 'Nc6' }).waitFor({ timeout: 10000 })
  await shot(alice, '32-chess')
  await bob.getByRole('button', { name: 'Offer draw' }).click()
  await alice.locator('.draw-offer').getByRole('button', { name: 'Accept' }).click({ timeout: 10000 })
  await bob.getByText('Draw by agreement').first().waitFor({ timeout: 10000 })
  await openChannel(alice, 'general')
  await openChannel(bob, 'general')
  await bob.locator('.game-card .gc-status', { hasText: 'Draw by agreement' }).waitFor({ timeout: 5000 })

  step('@claude: only people with their own API key can ask')
  await bob.locator('.composer textarea').fill('@claude are you there?')
  await bob.locator('.claude-hint.warn', { hasText: "haven't added one" }).waitFor({ timeout: 5000 })
  await bob.keyboard.press('Enter')
  await bob.locator('.toast', { hasText: 'add your own Anthropic API key' }).waitFor({ timeout: 5000 })
  await alice.locator('.msg .text', { hasText: '@claude are you there?' }).waitFor({ timeout: 10000 })
  if (claudeLog.length) throw new Error('something called the API without a key')
  await alice.locator('.composer textarea').fill('@claude what does p2p mean?')
  await alice.locator('.claude-hint.warn a', { hasText: 'Add a key' }).click()
  await alice.locator('.settings-body input[type="password"]').fill('sk-ant-wrong-' + 'w'.repeat(28))
  await alice.getByRole('button', { name: 'Save key' }).click()
  await alice.locator('.error-text').waitFor({ timeout: 15000 })
  console.log('   a wrong key is refused:', (await alice.locator('.error-text').textContent()).trim())
  await alice.locator('.settings-body input[type="password"]').fill(TEST_KEY)
  await alice.getByRole('button', { name: 'Save key' }).click()
  await alice.locator('.key-row', { hasText: TEST_KEY.slice(-4) }).waitFor({ timeout: 15000 })
  await shot(alice, '33-claude-settings')
  const info = await alice.evaluate(() => window.__od.model.claude)
  if (JSON.stringify(info).includes(TEST_KEY)) throw new Error('the API key reached the window')
  const keyFile = fs.readFileSync(path.join(tmp, 'alice', 'claude.json'), 'utf8')
  if (info.encrypted && keyFile.includes(TEST_KEY)) throw new Error('the API key is stored in plain text')
  console.log('   key stored encrypted:', info.encrypted)
  await alice.keyboard.press('Escape')
  await alice.locator('.claude-hint:not(.warn)').waitFor({ timeout: 5000 })
  await alice.locator('.composer textarea').press('Enter')
  await bob.locator('.msg.draft').waitFor({ timeout: 10000 }) // bob watches the answer being written
  await shot(bob, '34-claude-writing')
  const answer = bob.locator('.msg.bot:not(.draft)', { hasText: 'peer-to-peer' })
  await answer.waitFor({ timeout: 20000 })
  await answer.locator('.asked-by', { hasText: 'Alice' }).waitFor()
  await bob.locator('.msg.draft').waitFor({ state: 'detached', timeout: 5000 })
  await alice.locator('.msg.bot:not(.draft)', { hasText: 'peer-to-peer' }).waitFor({ timeout: 5000 })
  let asks = claudeLog.filter(r => r.path.startsWith('/v1/messages'))
  if (asks.length !== 1) throw new Error(`expected 1 request to Claude, got ${asks.length}`)
  if (!asks[0].body.includes('what does p2p mean')) throw new Error('the question did not reach Claude')
  if (asks[0].body.includes('are you there') || asks[0].body.includes('works!')) throw new Error("Claude got Bob's messages although he didn't allow it")
  await shot(alice, '35-claude-answer')

  step('@claude: replying to Claude asks again; friends can let Claude read along')
  await bob.locator('.user-panel button[title="Settings"]').click()
  await bob.locator('.settings nav button', { hasText: 'Privacy' }).click()
  await bob.locator('.toggle-row', { hasText: 'Claude may read my messages' }).click()
  await bob.waitForFunction(() => window.__od.model.me.claude === true, null, { timeout: 5000 })
  await bob.keyboard.press('Escape')
  await alice.waitForFunction(() => { const m = window.__od.model; const g = m.groupsList()[0]; return [...g.members.values()].some(x => x.claude) }, null, { timeout: 10000 })
  await alice.locator('.msg.bot:not(.draft)', { hasText: 'peer-to-peer' }).hover()
  await alice.locator('.msg.bot:not(.draft)', { hasText: 'peer-to-peer' }).locator('.msg-tools button[title="Reply"]').click()
  await alice.locator('.claude-hint', { hasText: 'Replying to Claude asks it again' }).waitFor({ timeout: 5000 })
  await alice.locator('.composer textarea').fill('and what is a DHT?')
  await alice.keyboard.press('Enter')
  await bob.locator('.msg.bot:not(.draft)').nth(1).waitFor({ timeout: 20000 })
  asks = claudeLog.filter(r => r.path.startsWith('/v1/messages'))
  if (asks.length !== 2) throw new Error(`expected a 2nd request to Claude, got ${asks.length}`)
  if (!asks[1].body.includes('what is a DHT') || !asks[1].body.includes('are you there')) throw new Error('the reply, or the opted-in friend, did not reach Claude')
  // an admin turns @claude off for the whole group
  await alice.locator('.group-header').click()
  await alice.locator('.dropdown button', { hasText: 'Claude settings' }).click()
  await alice.locator('.modal .toggle-row').click()
  await alice.locator('.modal footer').getByRole('button', { name: 'Done' }).click()
  await bob.waitForFunction(() => { const m = window.__od.model; return !m.claudeAllowed(m.groupsList().find(x => !x.dm)) }, null, { timeout: 10000 })
  await alice.locator('.composer textarea').fill('@claude still there?')
  await alice.locator('.claude-hint.warn', { hasText: 'turned Claude off' }).waitFor({ timeout: 5000 })
  await alice.locator('.composer textarea').fill('')

  step('search')
  await bob.keyboard.press('Control+f')
  await bob.locator('.search-panel input').fill('fully p2p')
  await bob.locator('.search-hit', { hasText: 'Alice' }).first().waitFor({ timeout: 5000 })
  await bob.locator('.search-panel input').fill('from:bob works')
  await bob.locator('.search-hit', { hasText: 'no servers' }).waitFor({ timeout: 5000 })
  if (await bob.locator('.search-hit').count() !== 1) throw new Error('search filters did not narrow it down')
  const hitAvatar = await bob.locator('.search-hit .avatar').first().boundingBox()
  if (hitAvatar.width > 30) throw new Error('search result avatars are ' + hitAvatar.width + ' px wide')
  await settle(bob)
  await shot(bob, '40-search')
  await bob.locator('.search-hit').first().click()
  await bob.locator('.msg.flash, .msg', { hasText: 'works!' }).first().waitFor({ timeout: 5000 })
  await bob.locator('.search-panel button[title="Close (Esc)"]').click()

  step('profile card from the chat')
  await bob.locator('.msg .author.clickable', { hasText: 'Alice' }).first().click()
  await bob.locator('.profile-menu .pc-name', { hasText: 'Alice' }).waitFor({ timeout: 5000 })
  await bob.locator('.profile-menu .pc-status', { hasText: 'Online' }).waitFor()
  await settle(bob)
  await shot(bob, '41-profile-card')
  await bob.keyboard.press('Escape')

  step('poll')
  await alice.locator('.composer textarea').fill('/poll Pizza tonight?')
  await alice.keyboard.press('Enter')
  await alice.locator('.modal input[placeholder="Answer 1"]').fill('Yes')
  await alice.locator('.modal input[placeholder="Answer 2"]').fill('Only if it has pineapple')
  await alice.getByRole('button', { name: 'Post poll' }).click()
  await bob.locator('.poll-card', { hasText: 'Pizza tonight?' }).waitFor({ timeout: 10000 })
  await bob.locator('.poll-opt', { hasText: 'pineapple' }).click()
  await alice.locator('.poll-foot', { hasText: '1 vote' }).waitFor({ timeout: 10000 })
  await alice.locator('.poll-opt', { hasText: 'Yes' }).click()
  await bob.locator('.poll-foot', { hasText: '2 votes' }).waitFor({ timeout: 10000 })
  await shot(bob, '42-poll')

  step('status: away and appear offline')
  const statusBtn = (label) => alice.locator('.status-menu button', { has: alice.locator('b', { hasText: new RegExp('^' + label + '$') }) })
  await alice.locator('.up-me').click()
  await statusBtn('Away').click()
  await bob.locator('.member', { hasText: 'Alice' }).locator('.presence.away').waitFor({ timeout: 10000 })
  await alice.locator('.up-me').click()
  await statusBtn('Appear offline').click()
  await bob.locator('.member.off', { hasText: 'Alice' }).waitFor({ timeout: 10000 })
  await shot(bob, '43-status')
  await alice.locator('.up-me').click()
  await statusBtn('Online').click()
  await bob.locator('.member:not(.off)', { hasText: 'Alice' }).locator('.presence.online').waitFor({ timeout: 10000 })

  step('poker: a hand dealt by mental poker')
  await alice.locator('.composer textarea').fill('/poker')
  await alice.keyboard.press('Enter')
  await alice.locator('.modal .seg-pick button.active', { hasText: 'Poker' }).waitFor()
  await alice.getByRole('button', { name: 'Open table' }).click()
  await alice.locator('.pk-felt').waitFor({ timeout: 5000 })
  await bob.locator('.poker-card').getByRole('button', { name: 'Take a seat' }).click({ timeout: 15000 })
  await bob.locator('.pk-felt').waitFor({ timeout: 5000 })
  await alice.getByRole('button', { name: 'Start dealing' }).click({ timeout: 10000 })
  for (const page of [alice, bob]) await page.waitForFunction(() => document.querySelectorAll('.pk-hole.mine .pcard:not(.back)').length === 2, null, { timeout: 30000 })
  const holes = await Promise.all([alice, bob].map(p => p.evaluate(() => [...document.querySelectorAll('.pk-hole.mine .pcard')].map(c => c.textContent).join(' '))))
  console.log('   alice holds', holes[0], '· bob holds', holes[1])
  const peek = await bob.evaluate(() => { const m = window.__od.model; const g = m.groupsList()[0]; const gm = [...g.games.values()].find(x => x.info?.kind === 'poker'); const st = m.gameState(g, gm.id); const ai = st.hand.players.indexOf(st.by); return [2 * ai, 2 * ai + 1].map(j => gm.cards.get(st.hand.h + ':' + j) ?? gm.mine.get(st.hand.h + ':' + j) ?? null) })
  if (peek.some(c => c != null)) throw new Error("bob's app could open alice's cards")
  await shot(alice, '44-poker')
  // whoever acts first calls, the other checks, then everyone checks to the showdown
  const handOver = () => alice.evaluate(() => /\bwins?\b|cancelled/.test(document.querySelector('.pk-status')?.textContent || ''))
  for (let i = 0; i < 20; i++) {
    let turn = -1
    for (let w = 0; w < 150 && turn < 0; w++) {
      if (await handOver()) break
      for (const [k, p] of [alice, bob].entries()) if (await p.locator('.pk-actions').count()) { turn = k; break }
      if (turn < 0) await alice.waitForTimeout(200)
    }
    if (turn < 0) break
    const page = [alice, bob][turn]
    const label = (await page.locator('.pk-actions .btn').nth(1).textContent()).trim()
    if (!/Check|Call/.test(label)) throw new Error('unexpected action ' + label)
    await page.locator('.pk-actions .btn').nth(1).click()
    await page.locator('.pk-actions').waitFor({ state: 'detached', timeout: 10000 })
  }
  await alice.locator('.pk-status', { hasText: /win/ }).waitFor({ timeout: 20000 })
  await bob.locator('.pk-status', { hasText: /win/ }).waitFor({ timeout: 5000 })
  console.log('   result:', (await alice.locator('.pk-status').textContent()).trim())
  await shot(bob, '45-poker-showdown')
  await alice.getByRole('button', { name: 'Pause after this hand' }).click()
  await openChannel(alice, 'general')
  await openChannel(bob, 'general')

  step('update required screen')
  await alice.evaluate(() => { const m = window.__od.model; const g = m.groupsList()[0]; m.compat = [{ key: [...g.online.keys()][0], version: '9.9.9', reason: 'update-me', groups: [g.id] }]; m.emit() })
  await alice.locator('.update-required h1', { hasText: 'Time to update' }).waitFor({ timeout: 5000 })
  await alice.locator('.update-required', { hasText: 'Bob' }).waitFor()
  await settle(alice)
  await shot(alice, '46-update-required')
  await alice.evaluate(() => { const m = window.__od.model; m.compat = [{ key: [...m.groupsList()[0].online.keys()][0], version: '0.4.0', reason: 'update-them', groups: [m.groupsList()[0].id] }]; m.emit() })
  await alice.locator('.update-required').waitFor({ state: 'detached', timeout: 5000 })
  await alice.locator('.banner.warn', { hasText: "can't sync with yours" }).waitFor({ timeout: 5000 })
  await alice.evaluate(() => { window.__od.model.compat = []; window.__od.model.emit() })

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

  step('soundboard')
  await alice.evaluate(async () => {
    // a 0.3 s beep as a WAV file
    const rate = 8000
    const n = rate * 0.3
    const buf = new ArrayBuffer(44 + n * 2)
    const v = new DataView(buf)
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 660) * 8000, true)
    const a = await window.od.importData('beep.wav', 'audio/wav', new Uint8Array(buf))
    const g = window.__od.model.groupsList()[0]
    const op = await window.od.append(g.id, 'sound.add', { id: 'beep1', name: 'Beep', emoji: '🔔', h: a.h, s: a.s, m: a.m, dur: 300 })
    window.__od.model.applyOps(g.id, [op])
  })
  await bob.locator('.voice-panel button[title="Soundboard"]').click()
  await bob.locator('.sb-sound', { hasText: 'Beep' }).waitFor({ timeout: 10000 })
  await settle(bob)
  await shot(bob, '47-soundboard')
  await bob.locator('.sb-sound', { hasText: 'Beep' }).click()
  await alice.waitForFunction(() => window.__od.model.lastSound?.id === 'beep1' && window.__od.model.lastSound.key !== window.__od.model.me.key, null, { timeout: 10000 })
  console.log('   alice heard bob play a sound')
  await bob.keyboard.press('Escape')
  await bob.locator('.voice-panel button[title="Soundboard"]').click()

  step('muted: not a single audio packet leaves the PC')
  const sendsAudio = (page) => page.evaluate(() => [...window.__od.voice.calls.values()].some(c => c.pc.getSenders().some(s => s.track?.kind === 'audio')))
  const audioIn = (page) => page.evaluate(async () => {
    let n = 0
    for (const c of window.__od.voice.calls.values()) (await c.pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.bytesReceived || 0 })
    return n
  })
  const audioOver = async (ms) => { const a = await audioIn(bob); await bob.waitForTimeout(ms); return (await audioIn(bob)) - a }
  if (!(await sendsAudio(alice))) throw new Error('alice sends no audio while unmuted')
  if (await audioOver(1500) <= 0) throw new Error('bob hears nothing from alice while she is unmuted')
  await alice.evaluate(() => window.__od.voice.toggleMute())
  await alice.waitForTimeout(800)
  if (await sendsAudio(alice)) throw new Error('alice still sends her mic while muted')
  const leaked = await audioOver(2500)
  console.log(`   audio bytes bob got from muted alice in 2.5 s: ${leaked}`)
  if (leaked > 0) throw new Error('audio still arrives from a muted mic')
  await alice.evaluate(() => window.__od.voice.toggleMute())
  await alice.waitForTimeout(500)
  if (await audioOver(1500) <= 0) throw new Error('audio did not come back after unmuting')

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
  await alice.locator('.tile-viewers.none').waitFor({ timeout: 5000 })
  await bob.locator('.tile.screen .watch-btn').waitFor({ timeout: 20000 })
  if (await bob.locator('.tile.screen video').count()) throw new Error('stream started before bob chose to watch')
  const sentBefore = await alice.evaluate(() => [...window.__od.voice.calls.values()][0]?.sendingScreen)
  if (sentBefore) throw new Error('alice sends her screen to someone who is not watching')
  await shot(bob, '29-watch-card')
  await bob.locator('.tile.screen .watch-btn').click()
  await bob.locator('.tile.screen video').waitFor({ timeout: 20000 })
  await alice.locator('.tile-viewers', { hasText: 'Bob' }).waitFor({ timeout: 10000 })
  await alice.locator('.vp-note.watchers', { hasText: 'Bob' }).waitFor({ timeout: 5000 })
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

  step('stop watching, then watch again')
  await bob.locator('.tile.screen').hover()
  await bob.locator('.tile.screen .stop-watch').click()
  await bob.locator('.tile.screen .watch-btn').waitFor({ timeout: 5000 })
  await alice.locator('.tile-viewers.none').waitFor({ timeout: 10000 })
  await alice.waitForFunction(() => ![...window.__od.voice.calls.values()][0]?.sendingScreen, null, { timeout: 10000 })
  console.log('   alice stopped sending video once bob stopped watching')
  await bob.locator('.tile.screen .watch-btn').click()
  await bob.locator('.tile.screen video').waitFor({ timeout: 20000 })
  await alice.locator('.tile-viewers', { hasText: 'Bob' }).waitFor({ timeout: 10000 })
  if (await bob.locator('.tile.screen .stream-mute').count()) {
    await bob.locator('.tile.screen').hover()
    await bob.locator('.tile.screen .stream-mute').click()
    await bob.locator('.tile.screen .stream-mute.off').waitFor({ timeout: 3000 })
    console.log('   stream sound muted')
  } else console.log('   (this capture has no sound, so there is no stream mute button)')

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

  step('forged voice messages from a member can\'t open a call')
  const aliceKey = await alice.evaluate(() => window.__od.model.me.key)
  const voiceOf = (page) => page.evaluate(() => ({ active: window.__od.voice.active?.ch || null, calls: window.__od.voice.calls.size, mic: !!window.__od.voice.local.mic }))
  // alice isn't in any voice channel: bob claims to be in one with her and sends her an offer
  await bob.evaluate((alice) => {
    const m = window.__od.model
    const g = m.groupsList().find(x => !x.dm)
    const vc = m.orderedChannels(g, 'voice')[0].id
    window.od.sendEph(g.id, alice, { type: 'voice', ch: vc, sid: 'evil-1', muted: false, watch: [alice] })
    window.od.sendEph(g.id, alice, { type: 'rtc', from: 'evil-1', to: 'evil-guess', sdp: { type: 'offer', sdp: 'v=0\r\n' } })
  }, aliceKey)
  await alice.waitForTimeout(1500)
  let v = await voiceOf(alice)
  if (v.active || v.calls || v.mic) throw new Error('a forged voice state opened something: ' + JSON.stringify(v))
  // alice sits in Lounge alone: bob, who isn't, sends an offer to her session and asks to watch
  await alice.getByRole('button', { name: 'Lounge', exact: true }).click()
  await alice.waitForFunction(() => window.__od.voice.active?.ch === 'lounge1', null, { timeout: 10000 })
  await bob.waitForFunction((alice) => window.__od.model.groupsList().find(x => !x.dm).voice.get(alice)?.ch === 'lounge1', aliceKey, { timeout: 10000 })
  await bob.evaluate((alice) => {
    const m = window.__od.model
    const g = m.groupsList().find(x => !x.dm)
    const sid = g.voice.get(alice).sid
    const other = m.orderedChannels(g, 'voice').find(c => c.id !== 'lounge1').id
    window.od.sendEph(g.id, alice, { type: 'voice', ch: other, sid: 'evil-2', muted: false, watch: [alice] })
    window.od.sendEph(g.id, alice, { type: 'rtc', from: 'evil-2', to: sid, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
  }, aliceKey)
  await alice.waitForTimeout(1500)
  v = await voiceOf(alice)
  if (v.calls) throw new Error('someone outside the channel got a connection')
  console.log('   forged states and offers ignored:', JSON.stringify(v))
  await alice.evaluate(() => window.__od.voice.leave())
  await bob.evaluate(() => window.od.sendEph(window.__od.model.groupsList().find(x => !x.dm).id, null, { type: 'voice', ch: null }))

  step('friends: one-time friend link, private chat')
  await alice.locator('.rail-btn.home').click()
  await alice.locator('.friends-tabs button.add').click()
  await alice.getByRole('button', { name: 'Create a friend link' }).click()
  const friendLink = (await alice.locator('.add-friend .invite-box code').textContent()).trim()
  if (!friendLink.startsWith('opendiscord://friend/')) throw new Error('bad friend link ' + friendLink)
  await alice.locator('.add-friend .invite-row').waitFor()
  await shot(alice, '19-add-friend')
  await bob.locator('.rail-btn.home').click()
  await bob.locator('.friends-tabs button.add').click()
  await bob.locator('.add-row input').fill(friendLink)
  await bob.locator('.add-row .btn.primary').click()
  await alice.locator('.dm-item:not(.pending)', { hasText: 'Bob' }).waitFor({ timeout: 20000 })
  await bob.locator('.dm-item:not(.pending)', { hasText: 'Alice' }).waitFor({ timeout: 20000 })
  await alice.locator('.add-friend .invite-row').waitFor({ state: 'detached', timeout: 5000 })
  await alice.locator('.dm-item', { hasText: 'Bob' }).click()
  await alice.locator('.chat-header h2', { hasText: 'Bob' }).waitFor({ timeout: 5000 })
  await alice.locator('.chat-header .presence.online').waitFor({ timeout: 10000 })
  await bob.locator('.dm-item', { hasText: 'Alice' }).click()
  await bob.locator('.composer textarea').fill('just between us 🤫')
  await bob.keyboard.press('Enter')
  await alice.locator('.msg .text', { hasText: 'just between us' }).waitFor({ timeout: 10000 })
  await shot(alice, '21-private-chat')
  await alice.locator('.chat-header button[title="Shared tasks"]').click()
  await alice.locator('.quick-add input').fill('Plan the trip')
  await alice.keyboard.press('Enter')
  await bob.locator('.chat-header button[title="Shared tasks"]').click()
  await bob.locator('.task-card', { hasText: 'Plan the trip' }).waitFor({ timeout: 10000 })
  await alice.locator('.chat-header button[title="Back to the chat"]').click()
  await bob.locator('.chat-header button[title="Back to the chat"]').click()
  await alice.locator('.composer textarea').waitFor()

  step('private call, over the fallback path (as if no direct route worked)')
  for (const p of [alice, bob]) await p.evaluate(() => { window.__od.model.forceRelay = true })
  await alice.locator('.chat-header button[title="Start a call"]').click()
  await bob.locator('.call-banner').waitFor({ timeout: 10000 })
  await shot(bob, '22-incoming-call')
  await bob.locator('.call-banner .round-btn[title="Accept"]').click()
  await alice.locator('.tile-conn.good').waitFor({ timeout: 45000 })
  await bob.locator('.tile-conn.good').waitFor({ timeout: 45000 })
  await alice.waitForFunction(() => [...window.__od.voice.calls.values()].some(c => c.stats?.path === 'relay'), null, { timeout: 15000 })
  console.log('   private call connected:', (await alice.locator('.tile-conn').textContent()).trim())
  for (const p of [alice, bob]) await p.evaluate(() => { window.__od.model.forceRelay = false })
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

  step('backup, then restore it on a "new PC"')
  const backupFile = path.join(tmp, 'alice.odbackup')
  await alice.locator('.user-panel button[title="Settings"]').click()
  await alice.locator('.settings nav button', { hasText: 'Account' }).click()
  await alice.locator('.settings-body', { hasText: "You haven't made a backup yet" }).waitFor()
  await alice.keyboard.press('Escape')
  await alice.evaluate((file) => window.__od.model.openModal('backup', { testPath: file }), backupFile)
  await alice.locator('.modal input[type="password"]').first().fill('pizza with pineapple')
  await alice.locator('.modal input[type="password"]').nth(1).fill('pizza with pineapple')
  await alice.getByRole('button', { name: 'Save backup…' }).click()
  await alice.locator('.toast', { hasText: 'Backup saved' }).waitFor({ timeout: 10000 })
  if (fs.readFileSync(backupFile, 'utf8').includes('Alice')) console.log('   (the account name is readable in the backup header, by design)')
  const aliceKeyBefore = await alice.evaluate(() => window.__od.model.me.key)
  await apps[0].close()
  const fresh = await launch('alice-newpc')
  await fresh.getByPlaceholder('What your friends call you').waitFor()
  await fresh.evaluate((file) => window.__od.model.openModal('restore', { testPath: file }), backupFile)
  await fresh.getByRole('button', { name: 'Choose backup file…' }).click()
  await fresh.locator('.backup-file b', { hasText: 'Alice' }).waitFor({ timeout: 5000 })
  await fresh.locator('.modal input[type="password"]').fill('wrong password')
  await fresh.getByRole('button', { name: 'Restore and restart' }).click()
  await fresh.locator('.modal .error-text', { hasText: 'Wrong password' }).waitFor({ timeout: 10000 })
  await fresh.locator('.modal input[type="password"]').fill('pizza with pineapple')
  const closed = apps[apps.length - 1].waitForEvent('close', { timeout: 20000 })
  await fresh.getByRole('button', { name: 'Restore and restart' }).click()
  await closed
  const restored = await launch('alice-newpc')
  await restored.locator('.user-panel b', { hasText: 'Alice' }).waitFor({ timeout: 15000 })
  if (await restored.evaluate(() => window.__od.model.me.key) !== aliceKeyBefore) throw new Error('restored a different identity')
  await restored.locator('.rail-btn.home').click()
  await restored.locator('.dm-item', { hasText: 'Bob' }).click({ timeout: 15000 })
  await restored.locator('.msg .text', { hasText: 'just between us' }).waitFor({ timeout: 45000 })
  await restored.locator('.composer textarea').waitFor({ timeout: 15000 })
  await restored.locator('.composer textarea').fill('I am back on a new PC')
  await restored.keyboard.press('Enter')
  await bob.locator('.rail-btn.home').click()
  await bob.locator('.dm-item', { hasText: 'Alice' }).click()
  await bob.locator('.msg .text', { hasText: 'I am back on a new PC' }).waitFor({ timeout: 15000 })
  await shot(restored, '48-restored')

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
  for (const app of apps) await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))])
  await testnet.destroy()
  claudeMock.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
